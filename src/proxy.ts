import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";

import {
  MEDIA_PROXY,
  type MediaProxyMode,
  verifyProxySignature,
} from "./media-proxy";
import {
  fetchProxyMedia,
  PROXY_CACHE_CONTROL,
  proxyCacheKeyForUrl,
  readProxyCacheEntry,
  toExactArrayBuffer,
  writeProxyCacheEntry,
} from "./proxy-cache";

const logger = getLogger(["hollo", "media-proxy"]);

const FETCH_TIMEOUT_MS = 30_000;

const RESPONSE_HEADERS = (contentType: string): Record<string, string> => ({
  "Content-Type": contentType,
  "Cache-Control": PROXY_CACHE_CONTROL,
  // Prevent the browser from MIME-sniffing the body into a different,
  // possibly active, content type.
  "X-Content-Type-Options": "nosniff",
});

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
      const cached = await readProxyCacheEntry(proxyCacheKeyForUrl(url));
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
      const upstream = await fetchProxyMedia(
        url,
        controller.signal,
        forwardedHeaders,
      );
      if (upstream == null) return c.notFound();
      // 416 Range Not Satisfiable: pass the status through with Content-Range
      // if the upstream supplied one, but discard the body to avoid forwarding
      // an arbitrary error page under our origin.
      if (upstream.status === 416) {
        const headers: Record<string, string> = {
          "Cache-Control": PROXY_CACHE_CONTROL,
          "X-Content-Type-Options": "nosniff",
        };
        if (upstream.contentRange != null) {
          headers["Content-Range"] = upstream.contentRange;
        }
        return c.body(null, 416, headers);
      }
      const isPartial = upstream.status === 206;

      // Only cache full (200) responses.  Partial responses and any request
      // that carried a Range header skip the write so the on-disk entry
      // always represents the complete resource.
      if (mode === "cache" && !isPartial && !isRangeRequest) {
        try {
          await writeProxyCacheEntry(
            proxyCacheKeyForUrl(url),
            upstream.body,
            upstream.contentType,
          );
        } catch (error) {
          logger.warn("Failed to write proxy cache for {url}: {error}", {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const responseHeaders: Record<string, string> = {
        ...RESPONSE_HEADERS(upstream.contentType),
      };
      if (upstream.contentRange != null) {
        responseHeaders["Content-Range"] = upstream.contentRange;
      }
      if (upstream.acceptRanges != null) {
        responseHeaders["Accept-Ranges"] = upstream.acceptRanges;
      }

      return c.body(
        toExactArrayBuffer(upstream.body),
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
