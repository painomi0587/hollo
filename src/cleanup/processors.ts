import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";

import db from "../db";
import * as schema from "../schema";
import { drive } from "../storage";
import { STORAGE_URL_BASE } from "../storage-config";
import type { Uuid } from "../uuid";

const logger = getLogger(["hollo", "cleanup"]);

// Match exactly what writeCached() in src/proxy.ts mints: a sha256 hex digest
// (64 lowercase hex chars) under the "proxy/" prefix, suffixed with ".bin".
// Rejects path traversal (../) and any other shape we did not produce.
const PROXY_CACHE_BIN_KEY = /^proxy\/[0-9a-f]{64}\.bin$/;

interface ThumbnailCleanupItemData {
  kind?: "thumbnail";
  id: Uuid;
}

interface ProxyCacheCleanupItemData {
  kind: "proxy_cache";
  key: string;
}

type CleanupItemData = ThumbnailCleanupItemData | ProxyCacheCleanupItemData;

// Single entry point used by the worker.  The cleanup_thumbnails enum value
// historically meant "delete a Hollo-derived sharp thumbnail"; we now also
// queue proxy-cache files under it (distinguished by data.kind) so we don't
// need a schema migration for an extra enum value.
export async function processCleanupItem(
  item: schema.CleanupJobItem,
): Promise<void> {
  const data = item.data as unknown as CleanupItemData;
  if (data != null && data.kind === "proxy_cache") {
    await processProxyCacheDeletion(data);
    return;
  }
  await processThumbnailDeletion(item);
}

export async function processThumbnailDeletion(
  item: schema.CleanupJobItem,
): Promise<void> {
  const data = item.data as unknown as ThumbnailCleanupItemData;

  const medium = await db.query.media.findFirst({
    where: eq(schema.media.id, data.id),
  });

  if (medium == null) {
    throw new Error(`medium missing in database: ${data.id}`);
  }

  if (STORAGE_URL_BASE == null) {
    throw new Error("storage url is not configured");
  }

  const key = medium.thumbnailUrl.split("/").slice(-3).join("/");

  const reconstructedUrl = new URL(
    key,
    STORAGE_URL_BASE + (STORAGE_URL_BASE.endsWith("/") ? "" : "/"),
  ).toString();

  if (reconstructedUrl !== medium.thumbnailUrl) {
    if (!medium.thumbnailUrl.startsWith(STORAGE_URL_BASE)) {
      throw new Error(
        `The thumbnail URL ${medium.thumbnailUrl} does not match the storage URL pattern ${STORAGE_URL_BASE}!`,
      );
    } else {
      throw new Error(`The thumbnail URL ${medium.thumbnailUrl} is malformed.`);
    }
  }

  const disk = drive.use();
  await disk.delete(key);
  await db
    .update(schema.media)
    .set({ thumbnailCleaned: true })
    .where(eq(schema.media.id, medium.id));
}

async function processProxyCacheDeletion(
  data: ProxyCacheCleanupItemData,
): Promise<void> {
  if (typeof data.key !== "string" || !PROXY_CACHE_BIN_KEY.test(data.key)) {
    throw new Error(`Invalid proxy cache key: ${String(data.key)}`);
  }
  const disk = drive.use();
  const stem = data.key.slice(0, -".bin".length);
  // Deleting the body is required; we want a failed delete to surface as a
  // failed item so it can be retried, instead of being silently lost.
  await disk.delete(`${stem}.bin`);
  // The JSON sidecar is best-effort: a previous partial cleanup may have
  // already removed it, and that should not flip the item to failed.
  try {
    await disk.delete(`${stem}.json`);
  } catch (error) {
    logger.warn("Proxy cache sidecar delete failed for {key}: {error}", {
      key: `${stem}.json`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Streams every .bin entry currently in the proxy cache, one key at a time.
// Pages through every listing page so S3 buckets with more than one page are
// fully enumerated.  Yielding (instead of collecting into an array) keeps the
// dashboard count and the cleanup-job enqueue path constant-memory regardless
// of how large the cache has grown.
export async function* iterateProxyCacheBinKeys(): AsyncGenerator<
  string,
  void,
  void
> {
  const disk = drive.use();
  let paginationToken: string | undefined;
  do {
    const result = await disk.listAll("proxy/", {
      recursive: true,
      paginationToken,
    });
    for (const obj of result.objects) {
      if (obj.isFile && PROXY_CACHE_BIN_KEY.test(obj.key)) {
        yield obj.key;
      }
    }
    paginationToken = result.paginationToken;
  } while (paginationToken != null);
}

export async function countProxyCacheBinKeys(): Promise<number> {
  let count = 0;
  for await (const _key of iterateProxyCacheBinKeys()) count++;
  return count;
}
