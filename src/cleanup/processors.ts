import { getLogger } from "@logtape/logtape";
import { eq, sql } from "drizzle-orm";

import db from "../db";
import * as schema from "../schema";
import { drive } from "../storage";
import { STORAGE_URL_BASE } from "../storage-config";
import { type Uuid, uuidv7 } from "../uuid";

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

interface EnumerateProxyCacheItemData {
  kind: "enumerate_proxy_cache";
}

type CleanupItemData =
  | ThumbnailCleanupItemData
  | ProxyCacheCleanupItemData
  | EnumerateProxyCacheItemData;

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
  if (data != null && data.kind === "enumerate_proxy_cache") {
    await processProxyCacheEnumeration(item);
    return;
  }
  await processThumbnailDeletion(item);
}

export async function processThumbnailDeletion(
  item: schema.CleanupJobItem,
): Promise<void> {
  const data = item.data as unknown as ThumbnailCleanupItemData;

  const medium = await db.query.media.findFirst({
    where: { id: { eq: data.id } },
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

// Walks the proxy cache and enqueues one per-key deletion item per .bin
// entry under the same parent job.  Run by the worker (not by the admin
// request handler) so the dashboard POST stays responsive even on a
// multi-million-entry cache, and so the worker is the sole owner of the
// job lifecycle — that's what stops the previous "worker picks up an
// empty pending job and finalizes it mid-enqueue" race.
async function processProxyCacheEnumeration(
  item: schema.CleanupJobItem,
): Promise<void> {
  const BATCH_SIZE = 1000;
  const jobId = item.jobId;
  let batch: Array<{
    id: Uuid;
    jobId: Uuid;
    data: { kind: "proxy_cache"; key: string };
  }> = [];
  let added = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await db.insert(schema.cleanupJobItems).values(batch);
    batch = [];
  };
  for await (const key of iterateProxyCacheBinKeys()) {
    batch.push({
      id: uuidv7(),
      jobId,
      data: { kind: "proxy_cache", key },
    });
    added++;
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  if (added > 0) {
    // Bump totalItems on the parent job by exactly the number we just
    // queued.  The enumeration item itself was already counted at job
    // creation, so we don't include it here.
    await db
      .update(schema.cleanupJobs)
      .set({
        totalItems: sql`${schema.cleanupJobs.totalItems} + ${added}`,
      })
      .where(eq(schema.cleanupJobs.id, jobId));
  }
  logger.info(
    "Enumerated proxy cache for cleanup job {jobId}: queued {count} items",
    { jobId, count: added },
  );
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

// Maximum value reported by countProxyCacheBinKeysBounded.  The dashboard
// only needs an order-of-magnitude indicator, so we stop the storage walk
// once we know there are at least this many entries instead of paging
// through every object on every page load.
export const PROXY_CACHE_COUNT_CAP = 10_000;

export interface ProxyCacheCountResult {
  count: number;
  truncated: boolean;
}

export async function countProxyCacheBinKeys(): Promise<ProxyCacheCountResult> {
  let count = 0;
  for await (const _key of iterateProxyCacheBinKeys()) {
    count++;
    if (count >= PROXY_CACHE_COUNT_CAP) return { count, truncated: true };
  }
  return { count, truncated: false };
}
