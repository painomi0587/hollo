import { createHash } from "node:crypto";

import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
// @ts-expect-error: No type definitions available
// cSpell: ignore ssrfcheck
import { isSSRFSafeURL } from "ssrfcheck";

import {
  MEDIA_PROXY,
  type MediaProxyMode,
  verifyProxySignature,
} from "./media-proxy";
import { drive } from "./storage";

const logger = getLogger(["hollo", "media-proxy"]);

const MAX_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const CACHE_PREFIX = "proxy/";
const ALLOWED_TYPE_PREFIXES = ["image/", "video/", "audio/"];
// SVG can carry inline scripts that execute under the serving origin, so
// proxying it would amount to a same-origin XSS primitive even when delivered
// with the right Content-Type.  Most fediverse media is PNG / JPEG / WebP /
// MP4, so the loss is small.
const BLOCKED_CONTENT_TYPES = new Set(["image/svg+xml", "image/svg"]);
const CACHE_CONTROL = "public, max-age=2592000, immutable";

interface CachedEntry {
  body: Uint8Array;
  contentType: string;
}

function cacheKeyForUrl(url: string): string {
  return CACHE_PREFIX + createHash("sha256").update(url).digest("hex");
}

function isAllowedContentType(value: string): boolean {
  const lower = value.toLowerCase().split(";", 1)[0].trim();
  if (BLOCKED_CONTENT_TYPES.has(lower)) return false;
  return ALLOWED_TYPE_PREFIXES.some((p) => lower.startsWith(p));
}

// Convert a Uint8Array to an ArrayBuffer with no surrounding bytes.  Node's
// `Buffer` uses a shared backing pool, so `.buffer` on a small read can
// expose unrelated memory if we don't slice to the view's exact range.
function toExactArrayBuffer(buf: Uint8Array): ArrayBuffer {
  if (
    buf.byteOffset === 0 &&
    buf.byteLength === buf.buffer.byteLength &&
    buf.buffer instanceof ArrayBuffer
  ) {
    return buf.buffer;
  }
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

const RESPONSE_HEADERS = (contentType: string): Record<string, string> => ({
  "Content-Type": contentType,
  "Cache-Control": CACHE_CONTROL,
  // Prevent the browser from MIME-sniffing the body into a different,
  // possibly active, content type.
  "X-Content-Type-Options": "nosniff",
});

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* upstream is already gone — nothing to do */
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader == null) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// Follow up to MAX_REDIRECTS redirects manually so we can re-run the SSRF
// check on each hop.  `fetch(..., { redirect: "follow" })` would silently
// chase a 302 from a public hostname to a private one.
//
// Caveat for future maintainers: `isSSRFSafeURL` only inspects the URL
// string (scheme, host literal, port).  It does not resolve DNS, so a
// hostname that looks public but resolves to a private address at fetch
// time can still slip through.  Fixing this in the proxy alone would
// leave the same gap on every other server-side fetch in the codebase
// (e.g. src/federation/post.ts, preview-card scraping); the proper fix
// is a shared SSRF-aware fetch connector that pins the resolved IP.
async function fetchWithSSRFAwareRedirects(
  initialUrl: string,
  signal: AbortSignal,
  requestHeaders: Record<string, string> = {},
): Promise<Response | null> {
  let url = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!isSSRFSafeURL(url)) return null;
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      headers: requestHeaders,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await discardBody(response);
      if (location == null) return null;
      try {
        url = new URL(location, url).href;
      } catch {
        return null;
      }
      continue;
    }
    return response;
  }
  return null;
}

async function readCached(key: string): Promise<CachedEntry | null> {
  const disk = drive.use();
  try {
    if (!(await disk.exists(`${key}.bin`))) return null;
    const meta = JSON.parse(await disk.get(`${key}.json`)) as {
      contentType?: unknown;
    };
    if (
      typeof meta.contentType !== "string" ||
      !isAllowedContentType(meta.contentType)
    ) {
      return null;
    }
    const body = await disk.getBytes(`${key}.bin`);
    return { body, contentType: meta.contentType };
  } catch (error) {
    logger.warn("Failed to read proxy cache entry {key}: {error}", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function writeCached(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const disk = drive.use();
  await disk.put(`${key}.bin`, body, {
    contentType,
    contentLength: body.byteLength,
    visibility: "public",
  });
  await disk.put(`${key}.json`, JSON.stringify({ contentType }), {
    contentType: "application/json",
    visibility: "public",
  });
}

export function createProxyApp(mode: MediaProxyMode = MEDIA_PROXY): Hono {
  const app = new Hono();
  if (mode === "off") return app;

  app.get("/:sig/:b64url", async (c) => {
    const sig = c.req.param("sig");
    const b64url = c.req.param("b64url");
    const url = verifyProxySignature(sig, b64url);
    if (url == null) return c.notFound();

    // Forward Range so audio/video clients can seek through the proxy.
    // Range requests bypass the disk cache on both read and write paths
    // because a single cache entry holds the full body, not partial slices.
    const rangeHeader = c.req.header("Range");
    const isRangeRequest = rangeHeader != null && rangeHeader.length > 0;

    if (mode === "cache" && !isRangeRequest) {
      const cached = await readCached(cacheKeyForUrl(url));
      if (cached != null) {
        return c.body(
          toExactArrayBuffer(cached.body),
          200,
          RESPONSE_HEADERS(cached.contentType),
        );
      }
    }

    const controller = new AbortController();
    // Keep the abort timer active across both the connect/headers phase and
    // the body read so a stalled upstream can't tie the request up.
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const forwardedHeaders: Record<string, string> = {};
      if (isRangeRequest) forwardedHeaders.Range = rangeHeader;
      const upstream = await fetchWithSSRFAwareRedirects(
        url,
        controller.signal,
        forwardedHeaders,
      );
      if (upstream == null) return c.notFound();
      // 416 Range Not Satisfiable: pass the status through with Content-Range
      // if the upstream supplied one, but discard the body to avoid forwarding
      // an arbitrary error page under our origin.
      if (upstream.status === 416) {
        await discardBody(upstream);
        const upstreamContentRange = upstream.headers.get("Content-Range");
        const headers: Record<string, string> = {
          "Cache-Control": CACHE_CONTROL,
          "X-Content-Type-Options": "nosniff",
        };
        if (upstreamContentRange != null) {
          headers["Content-Range"] = upstreamContentRange;
        }
        return c.body(null, 416, headers);
      }
      if (!upstream.ok) {
        await discardBody(upstream);
        return c.notFound();
      }
      const isPartial = upstream.status === 206;
      const contentType =
        upstream.headers.get("Content-Type") ?? "application/octet-stream";
      if (!isAllowedContentType(contentType)) {
        await discardBody(upstream);
        return c.notFound();
      }

      const body = await readBoundedBody(upstream, MAX_BYTES);
      if (body == null) return c.notFound();

      // Only cache full (200) responses.  Partial responses and any request
      // that carried a Range header skip the write so the on-disk entry
      // always represents the complete resource.
      if (mode === "cache" && !isPartial && !isRangeRequest) {
        try {
          await writeCached(cacheKeyForUrl(url), body, contentType);
        } catch (error) {
          logger.warn("Failed to write proxy cache for {url}: {error}", {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const responseHeaders: Record<string, string> = {
        ...RESPONSE_HEADERS(contentType),
      };
      const contentRange = upstream.headers.get("Content-Range");
      if (contentRange != null) responseHeaders["Content-Range"] = contentRange;
      const acceptRanges = upstream.headers.get("Accept-Ranges");
      if (acceptRanges != null) responseHeaders["Accept-Ranges"] = acceptRanges;

      return c.body(
        toExactArrayBuffer(body),
        isPartial ? 206 : 200,
        responseHeaders,
      );
    } catch (error) {
      logger.warn("Failed to fetch remote media {url}: {error}", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.notFound();
    } finally {
      clearTimeout(timeout);
    }
  });

  return app;
}

const proxy = createProxyApp();
export default proxy;
