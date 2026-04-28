import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import db, { type Transaction } from "../db";
import * as schema from "../schema";
import { processThumbnailDeletion } from "./processors";

const logger = getLogger(["hollo", "cleanup-worker"]);

// Configuration constants
const POLL_INTERVAL_MS = 5000; // Check for jobs every 5 seconds
const BATCH_SIZE = 100; // Items to fetch per poll
const CONCURRENT_ITEMS = 10; // Max parallel item processing

let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startCleanupWorker(): void {
  if (isRunning) {
    logger.warn("Cleanup worker is already running");
    return;
  }

  isRunning = true;
  logger.info("Starting cleanup worker");

  // Initial poll
  pollAndProcess().catch((error) => {
    logger.error("Error in cleanup cleanup worker poll: {error}", { error });
  });

  // Set up periodic polling
  pollTimer = setInterval(() => {
    pollAndProcess().catch((error) => {
      logger.error("Error in cleanup worker poll: {error}", { error });
    });
  }, POLL_INTERVAL_MS);
}

export function stopCleanupWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  logger.info("Cleanup worker stopped");
}

async function pollAndProcess(): Promise<void> {
  try {
    // Use a transaction with FOR UPDATE SKIP LOCKED to prevent
    // multiple workers from processing the same job
    await db.transaction(async (tx) => {
      // Find pending jobs and start them (only process one job at a time)
      const [pendingJob] = await tx
        .select()
        .from(schema.cleanupJobs)
        .where(eq(schema.cleanupJobs.status, "pending"))
        .orderBy(schema.cleanupJobs.created)
        .limit(1)
        .for("update", { skipLocked: true });

      if (pendingJob) {
        await startJob(tx, pendingJob);
        return; // Process one job per poll cycle
      }

      // Continue processing jobs that are already "processing"
      const [processingJob] = await tx
        .select()
        .from(schema.cleanupJobs)
        .where(eq(schema.cleanupJobs.status, "processing"))
        .limit(1)
        .for("update", { skipLocked: true });

      if (processingJob) {
        await processJobItems(tx, processingJob);
      }
    });
  } catch (error) {
    logger.error("Error in cleanup worker poll: {error}", { error });
  }
}

async function startJob(
  tx: Transaction,
  job: schema.CleanupJob,
): Promise<void> {
  logger.info("Starting cleanup job {jobId} for category {category}", {
    jobId: job.id,
    category: job.category,
  });

  await tx
    .update(schema.cleanupJobs)
    .set({
      status: "processing",
      startedAt: new Date(),
    })
    .where(eq(schema.cleanupJobs.id, job.id));

  await processJobItems(tx, {
    ...job,
    status: "processing",
    startedAt: new Date(),
  });
}

async function processJobItems(
  tx: Transaction,
  job: schema.CleanupJob,
): Promise<void> {
  // Check if job has been cancelled (use tx to see latest state within transaction)
  const [currentJob] = await tx
    .select()
    .from(schema.cleanupJobs)
    .where(eq(schema.cleanupJobs.id, job.id));

  if (!currentJob || currentJob.status === "cancelled") {
    logger.info("Cleanup job {jobId} was cancelled", { jobId: job.id });
    await finalizeJob(tx, job, "cancelled");
    return;
  }

  // Get unfinished items for this job with lock
  const unfinishedItems = await tx
    .select()
    .from(schema.cleanupJobItems)
    .where(
      and(
        eq(schema.cleanupJobItems.jobId, job.id),
        or(
          eq(schema.cleanupJobItems.status, "pending"),
          eq(schema.cleanupJobItems.status, "processing"),
        ),
      ),
    )
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });

  if (unfinishedItems.length === 0) {
    // No more items - mark job as completed
    await finalizeJob(tx, job, "completed");
    return;
  }

  const pendingItems = unfinishedItems.filter((i) => i.status == "pending");

  // Mark items as processing within the transaction
  const itemsToProcess = pendingItems.slice(0, CONCURRENT_ITEMS);
  const itemIds = itemsToProcess.map((item) => item.id);

  await tx
    .update(schema.cleanupJobItems)
    .set({ status: "processing" })
    .where(
      and(
        eq(schema.cleanupJobItems.jobId, job.id),
        inArray(schema.cleanupJobItems.id, itemIds),
      ),
    );

  // Update processed count within transaction
  await tx
    .update(schema.cleanupJobs)
    .set({
      processedItems: sql`${schema.cleanupJobs.processedItems} + ${itemsToProcess.length}`,
    })
    .where(eq(schema.cleanupJobs.id, job.id));

  // Process items outside the transaction (federation calls are external)
  // We schedule this to run after the transaction commits
  setTimeout(() => {
    Promise.allSettled(
      itemsToProcess.map((item) => processItem(job, item)),
    ).catch((error) => {
      logger.error("Error processing cleanup items: {error}", { error });
    });
  }, 0);
}

async function finalizeJob(
  tx: Transaction,
  job: schema.CleanupJob,
  status: "completed" | "cancelled" | "failed",
): Promise<void> {
  const [stats] = await tx
    .select({
      successful:
        sql<number>`COUNT(*) FILTER (WHERE status = 'completed')`.mapWith(
          Number,
        ),
      failed: sql<number>`COUNT(*) FILTER (WHERE status = 'failed')`.mapWith(
        Number,
      ),
    })
    .from(schema.cleanupJobItems)
    .where(eq(schema.cleanupJobItems.jobId, job.id));

  await tx
    .update(schema.cleanupJobs)
    .set({
      status,
      completedAt: new Date(),
      successfulItems: stats.successful,
      failedItems: stats.failed,
    })
    .where(eq(schema.cleanupJobs.id, job.id));

  logger.info(
    "Cleanup job {jobId} {status}: {successful} successful, {failed} failed",
    {
      jobId: job.id,
      status,
      successful: stats.successful,
      failed: stats.failed,
    },
  );
}

async function processItem(
  job: schema.CleanupJob,
  item: schema.CleanupJobItem,
): Promise<void> {
  // Item is already marked as "processing" in the transaction
  try {
    switch (job.category) {
      case "cleanup_thumbnails":
        await processThumbnailDeletion(item);
        break;
    }

    await db
      .update(schema.cleanupJobItems)
      .set({
        status: "completed",
        processedAt: new Date(),
      })
      .where(eq(schema.cleanupJobItems.id, item.id));

    // Update successful count
    await db
      .update(schema.cleanupJobs)
      .set({
        successfulItems: sql`${schema.cleanupJobs.successfulItems} + 1`,
      })
      .where(eq(schema.cleanupJobs.id, job.id));
  } catch (error) {
    logger.error("Failed to process cleanup item {itemId}: {error}", {
      itemId: item.id,
      error,
    });

    await db
      .update(schema.cleanupJobItems)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        processedAt: new Date(),
      })
      .where(eq(schema.cleanupJobItems.id, item.id));

    // Update failed count
    await db
      .update(schema.cleanupJobs)
      .set({
        failedItems: sql`${schema.cleanupJobs.failedItems} + 1`,
      })
      .where(eq(schema.cleanupJobs.id, job.id));
  }
}
