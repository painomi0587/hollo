import { Collection, type DocumentLoader, lookupObject } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import db from "../db";
import {
  type RemoteReplyScrapeJob,
  posts,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
import { iterateCollection } from "./collection";
import { isPost, persistPost, updatePostStats } from "./post";
import {
  enqueueRemoteReplyScrape,
  laterBySeconds,
  REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS,
  REMOTE_REPLIES_SCRAPE_DEPTH,
  REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
  REMOTE_REPLIES_SCRAPE_MAX_ITEMS,
} from "./replies";

const logger = getLogger(["hollo", "federation", "replies-worker"]);

const POLL_INTERVAL_MS = 5000;
const STALE_PROCESSING_TIMEOUT_SECONDS = 15 * 60;

let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export interface ProcessRemoteReplyScrapeJobsOptions {
  backoffSeconds?: number;
  documentLoader?: DocumentLoader;
  intervalSeconds?: number;
  maxDepth?: number;
  maxItems?: number;
  maxJobs?: number;
  now?: Date;
  sleep?: (milliseconds: number) => Promise<void>;
  staleProcessingSeconds?: number;
  workerId?: string;
}

export function startRemoteReplyScrapeWorker(): void {
  if (isRunning) {
    logger.warn("Remote reply scrape worker is already running");
    return;
  }

  isRunning = true;
  logger.info("Starting remote reply scrape worker");

  pollAndProcess().catch((error) => {
    logger.error("Error in initial remote reply scrape worker poll: {error}", {
      error,
    });
  });

  pollTimer = setInterval(() => {
    pollAndProcess().catch((error) => {
      logger.error("Error in remote reply scrape worker poll: {error}", {
        error,
      });
    });
  }, POLL_INTERVAL_MS);
}

export function stopRemoteReplyScrapeWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  logger.info("Remote reply scrape worker stopped");
}

export async function processDueRemoteReplyScrapeJobs(
  options: ProcessRemoteReplyScrapeJobsOptions = {},
): Promise<number> {
  const maxJobs = options.maxJobs ?? 1;
  let processedItems = 0;

  for (let i = 0; i < maxJobs; i++) {
    const job = await claimRemoteReplyScrapeJob(
      options.workerId ?? `worker:${process.pid}`,
      options.now,
      options.staleProcessingSeconds,
    );
    if (job == null) break;
    processedItems += await processRemoteReplyScrapeJob(job, options);
  }

  return processedItems;
}

export async function claimRemoteReplyScrapeJob(
  _workerId: string,
  now = new Date(),
  staleProcessingSeconds = STALE_PROCESSING_TIMEOUT_SECONDS,
): Promise<RemoteReplyScrapeJob | null> {
  return await db.transaction(async (tx) => {
    const staleStartedBefore = new Date(
      now.getTime() - staleProcessingSeconds * 1000,
    );

    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "pending",
        nextAttemptAt: now,
        errorMessage: "Reclaimed stale processing job",
        startedAt: null,
        updated: now,
      })
      .where(
        and(
          eq(remoteReplyScrapeJobs.status, "processing"),
          lte(remoteReplyScrapeJobs.startedAt, staleStartedBefore),
        ),
      );

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: null,
        processingStartedAt: null,
        updated: now,
      })
      .where(
        and(
          isNotNull(remoteReplyScrapeOrigins.processingStartedAt),
          lte(remoteReplyScrapeOrigins.processingStartedAt, staleStartedBefore),
        ),
      );

    const [claimableJob] = await tx
      .select({ job: remoteReplyScrapeJobs })
      .from(remoteReplyScrapeJobs)
      .innerJoin(
        remoteReplyScrapeOrigins,
        eq(
          remoteReplyScrapeOrigins.originHost,
          remoteReplyScrapeJobs.originHost,
        ),
      )
      .where(
        and(
          eq(remoteReplyScrapeJobs.status, "pending"),
          lte(remoteReplyScrapeJobs.nextAttemptAt, now),
          isNull(remoteReplyScrapeOrigins.processingJobId),
          lte(remoteReplyScrapeOrigins.nextRequestAt, now),
        ),
      )
      .orderBy(asc(remoteReplyScrapeJobs.created))
      .limit(1)
      .for("update", { skipLocked: true });

    const job = claimableJob?.job;
    if (job == null) return null;

    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "processing",
        attempts: sql`${remoteReplyScrapeJobs.attempts} + 1`,
        startedAt: now,
        updated: now,
      })
      .where(eq(remoteReplyScrapeJobs.id, job.id));

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: job.id,
        processingStartedAt: now,
        updated: now,
      })
      .where(eq(remoteReplyScrapeOrigins.originHost, job.originHost));

    return {
      ...job,
      status: "processing",
      attempts: job.attempts + 1,
      startedAt: now,
      updated: now,
    };
  });
}

async function pollAndProcess(): Promise<void> {
  await processDueRemoteReplyScrapeJobs();
}

async function processRemoteReplyScrapeJob(
  job: RemoteReplyScrapeJob,
  options: ProcessRemoteReplyScrapeJobsOptions,
): Promise<number> {
  const now = options.now ?? new Date();
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, job.postId),
  });

  if (post == null) {
    await failJob(job, "Post not found", now);
    return 0;
  }

  try {
    const documentLoader =
      options.documentLoader ?? (await getDefaultDocumentLoader(job.baseUrl));
    const throttledDocumentLoader = createThrottledDocumentLoader(job, {
      documentLoader,
      intervalSeconds:
        options.intervalSeconds ?? REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
      now,
      sleep: options.sleep ?? sleep,
    });
    let lastFetchError: unknown;
    const recordingDocumentLoader: DocumentLoader = async (url, options) => {
      try {
        return await throttledDocumentLoader(url, options);
      } catch (error) {
        lastFetchError = error;
        throw error;
      }
    };
    const collection = await lookupObject(new URL(job.repliesIri), {
      documentLoader: recordingDocumentLoader,
    });

    if (collection == null && getErrorStatus(lastFetchError) === 429) {
      throw lastFetchError;
    }

    if (!(collection instanceof Collection)) {
      throw new Error(
        `Replies collection is not a Collection: ${job.repliesIri}`,
      );
    }

    let fetchedItems = 0;
    for await (const item of iterateCollection(collection, {
      documentLoader: recordingDocumentLoader,
    })) {
      if (
        fetchedItems >= (options.maxItems ?? REMOTE_REPLIES_SCRAPE_MAX_ITEMS)
      ) {
        break;
      }
      if (!isPost(item)) continue;

      const reply = await persistPost(db, item, job.baseUrl, {
        documentLoader: recordingDocumentLoader,
        enqueueRemoteReplies: false,
        replyTarget: post,
        skipUpdate: true,
      });
      if (reply == null) continue;

      fetchedItems++;
      const childRepliesIri = item.repliesId;
      if (
        childRepliesIri != null &&
        job.depth + 1 < (options.maxDepth ?? REMOTE_REPLIES_SCRAPE_DEPTH)
      ) {
        await enqueueRemoteReplyScrape(db, {
          baseUrl: job.baseUrl,
          depth: job.depth + 1,
          post: reply,
          repliesIri: childRepliesIri,
        });
      }
    }

    await updatePostStats(db, { id: job.postId });
    await updateScrapedRepliesCount(job.postId);
    await completeJob(job, fetchedItems, now);
    return fetchedItems;
  } catch (error) {
    if (getErrorStatus(error) === 429) {
      await backOffJob(
        job,
        retryAfterSeconds(error) ??
          options.backoffSeconds ??
          REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS,
        error,
        now,
      );
      return 0;
    }
    await failJob(
      job,
      error instanceof Error ? error.message : String(error),
      now,
    );
    return 0;
  }
}

function createThrottledDocumentLoader(
  job: RemoteReplyScrapeJob,
  {
    documentLoader,
    intervalSeconds,
    now,
    sleep,
  }: {
    documentLoader: DocumentLoader;
    intervalSeconds: number;
    now: Date;
    sleep: (milliseconds: number) => Promise<void>;
  },
): DocumentLoader {
  let originRequests = 0;

  return async (url, options) => {
    const sameOrigin = new URL(url).host === job.originHost;
    if (sameOrigin && originRequests > 0) {
      await sleep(intervalSeconds * 1000);
    }
    if (sameOrigin) originRequests++;

    try {
      return await documentLoader(url, options);
    } finally {
      if (sameOrigin) {
        const requestTime = now;
        await db
          .update(remoteReplyScrapeOrigins)
          .set({
            lastRequestAt: requestTime,
            nextRequestAt: laterBySeconds(intervalSeconds, requestTime),
            updated: requestTime,
          })
          .where(eq(remoteReplyScrapeOrigins.originHost, job.originHost));
      }
    }
  };
}

async function updateScrapedRepliesCount(
  postId: RemoteReplyScrapeJob["postId"],
) {
  await db.execute(sql`
    update ${posts}
    set replies_count = (
      select count(*)
      from ${posts} as replies
      where replies.reply_target_id = ${postId}
    )
    where ${posts.id} = ${postId}
  `);
}

async function completeJob(
  job: RemoteReplyScrapeJob,
  fetchedItems: number,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "completed",
        fetchedItems,
        completedAt: now,
        errorMessage: null,
        updated: now,
      })
      .where(eq(remoteReplyScrapeJobs.id, job.id));

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: null,
        processingStartedAt: null,
        updated: now,
      })
      .where(eq(remoteReplyScrapeOrigins.originHost, job.originHost));
  });
}

async function failJob(
  job: RemoteReplyScrapeJob,
  message: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "failed",
        errorMessage: message,
        completedAt: now,
        updated: now,
      })
      .where(eq(remoteReplyScrapeJobs.id, job.id));

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: null,
        processingStartedAt: null,
        updated: now,
      })
      .where(eq(remoteReplyScrapeOrigins.originHost, job.originHost));
  });
}

async function backOffJob(
  job: RemoteReplyScrapeJob,
  seconds: number,
  error: unknown,
  now: Date,
): Promise<void> {
  const nextAttemptAt = laterBySeconds(seconds, now);
  await db.transaction(async (tx) => {
    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "pending",
        nextAttemptAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        updated: now,
      })
      .where(eq(remoteReplyScrapeJobs.id, job.id));

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        nextRequestAt: nextAttemptAt,
        processingJobId: null,
        processingStartedAt: null,
        updated: now,
      })
      .where(eq(remoteReplyScrapeOrigins.originHost, job.originHost));
  });
}

async function getDefaultDocumentLoader(
  baseUrl: string,
): Promise<DocumentLoader> {
  const { federation } = await import("./index");
  const context = federation.createContext(new Request(baseUrl), undefined);
  return context.documentLoader;
}

function getErrorStatus(error: unknown): number | null {
  if (
    error == null ||
    typeof error !== "object" ||
    !("response" in error) ||
    !(error.response instanceof Response)
  ) {
    return null;
  }
  return error.response.status;
}

function retryAfterSeconds(error: unknown): number | null {
  if (
    error == null ||
    typeof error !== "object" ||
    !("response" in error) ||
    !(error.response instanceof Response)
  ) {
    return null;
  }

  const retryAfter = error.response.headers.get("Retry-After");
  if (retryAfter == null) return null;

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isInteger(seconds)) return seconds;

  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
