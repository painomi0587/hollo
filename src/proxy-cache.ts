import { createHash } from "node:crypto";

import { getLogger } from "@logtape/logtape";
// @ts-expect-error: No type definitions available
// cSpell: ignore ssrfcheck
import { isSSRFSafeURL } from "ssrfcheck";

import { type MediaProxyMode } from "./media-proxy";
import { drive } from "./storage";

const logger = getLogger(["hollo", "media-proxy"]);

export const PROXY_CACHE_CONTROL = "public, max-age=2592000, immutable";

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

export interface ProxyCacheEntry {
  body: Uint8Array;
  contentType: string;
}

export interface ProxyMediaResponse {
  status: 200 | 206;
  body: Uint8Array;
  contentType: string;
  contentRange: string | null;
  acceptRanges: string | null;
}

export interface ProxyRangeNotSatisfiableResponse {
  status: 416;
  contentRange: string | null;
}

export type ProxyFetchResult =
  | ProxyMediaResponse
  | ProxyRangeNotSatisfiableResponse;

export function proxyCacheKeyForUrl(url: string): string {
  return CACHE_PREFIX + createHash("sha256").update(url).digest("hex");
}

function isAllowedContentType(value: string): boolean {
  const lower = value.toLowerCase().split(";", 1)[0].trim();
  if (BLOCKED_CONTENT_TYPES.has(lower)) return false;
  return ALLOWED_TYPE_PREFIXES.some((p) => lower.startsWith(p));
}

// Convert a Uint8Array to an ArrayBuffer with no surrounding bytes.  Node's
// `Buffer` uses a shared backing pool, so `.buffer` on a small read can expose
// unrelated memory if we don't slice to the view's exact range.
export function toExactArrayBuffer(buf: Uint8Array): ArrayBuffer {
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

export async function discardBody(response: Response): Promise<void> {
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
// Caveat for future maintainers: `isSSRFSafeURL` only inspects the URL string
// (scheme, host literal, port).  It does not resolve DNS, so a hostname that
// looks public but resolves to a private address at fetch time can still slip
// through.  Fixing this in the proxy alone would leave the same gap on every
// other server-side fetch in the codebase (e.g. src/federation/post.ts,
// preview-card scraping); the proper fix is a shared SSRF-aware fetch connector
// that pins the resolved IP.
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

export async function readProxyCacheEntry(
  key: string,
): Promise<ProxyCacheEntry | null> {
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

export async function writeProxyCacheEntry(
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

export async function fetchProxyMedia(
  url: string,
  signal: AbortSignal,
  requestHeaders: Record<string, string> = {},
): Promise<ProxyFetchResult | null> {
  const upstream = await fetchWithSSRFAwareRedirects(
    url,
    signal,
    requestHeaders,
  );
  if (upstream == null) return null;

  if (upstream.status === 416) {
    await discardBody(upstream);
    return {
      status: 416,
      contentRange: upstream.headers.get("Content-Range"),
    };
  }
  if (!upstream.ok) {
    await discardBody(upstream);
    return null;
  }
  const status = upstream.status === 206 ? 206 : 200;
  const contentType =
    upstream.headers.get("Content-Type") ?? "application/octet-stream";
  if (!isAllowedContentType(contentType)) {
    await discardBody(upstream);
    return null;
  }

  // When the upstream tells us the body length up front we can short-circuit
  // oversized responses without spending bandwidth on the read.  A missing or
  // malformed header just falls through to the streaming cap inside
  // readBoundedBody, which still enforces the limit.
  const contentLengthHeader = upstream.headers.get("Content-Length");
  if (contentLengthHeader != null) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      await discardBody(upstream);
      return null;
    }
  }

  const body = await readBoundedBody(upstream, MAX_BYTES);
  if (body == null) return null;

  return {
    status,
    body,
    contentType,
    contentRange: upstream.headers.get("Content-Range"),
    acceptRanges: upstream.headers.get("Accept-Ranges"),
  };
}

export async function prefetchProxyCacheForMode(
  mode: MediaProxyMode,
  url: string | null | undefined,
): Promise<boolean> {
  if (mode !== "cache" || url == null) return false;
  const key = proxyCacheKeyForUrl(url);
  if ((await readProxyCacheEntry(key)) != null) return true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const result = await fetchProxyMedia(url, controller.signal);
    if (result == null || result.status !== 200) return false;
    await writeProxyCacheEntry(key, result.body, result.contentType);
    return true;
  } catch (error) {
    logger.warn("Failed to prefetch remote media cache for {url}: {error}", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
