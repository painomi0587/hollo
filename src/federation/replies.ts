import {
  and,
  count,
  eq,
  type ExtractTablesWithRelations,
  inArray,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

import type * as schema from "../schema";
import {
  type RemoteReplyScrapeJob,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
  type Post,
} from "../schema";
import { uuidv7 } from "../uuid";

export const REMOTE_REPLIES_SCRAPE_DEPTH = parseNonNegativeInteger(
  "REMOTE_REPLIES_SCRAPE_DEPTH",
  2,
);
export const REMOTE_REPLIES_SCRAPE_MAX_ITEMS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_MAX_ITEMS",
  100,
);
export const REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS",
  5,
);
export const REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS",
  300,
);
export const REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS = parseNonNegativeInteger(
  "REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS",
  300,
);

type Database = PgDatabase<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export async function enqueueRemoteReplyScrape(
  db: Database,
  {
    baseUrl,
    depth = 0,
    post,
    repliesIri,
  }: {
    baseUrl: URL | string;
    depth?: number;
    post: Post;
    repliesIri: URL;
  },
): Promise<void> {
  if (REMOTE_REPLIES_SCRAPE_DEPTH < 1) return;
  if (depth >= REMOTE_REPLIES_SCRAPE_DEPTH) return;

  const now = new Date();
  const originHost = repliesIri.host;
  const baseUrlString =
    typeof baseUrl === "string" ? new URL(baseUrl).origin : baseUrl.origin;
  const cooldownStartedAt = new Date(
    now.getTime() - REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS * 1000,
  );

  await db.transaction(async (tx) => {
    await tx
      .insert(remoteReplyScrapeOrigins)
      .values({
        originHost,
      })
      .onConflictDoNothing();

    const existingJob = await tx.query.remoteReplyScrapeJobs.findFirst({
      where: eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href),
    });

    if (
      existingJob != null &&
      isActiveOrCoolingDown(existingJob, cooldownStartedAt)
    ) {
      return;
    }

    const values = {
      postId: post.id,
      postIri: post.iri,
      repliesIri: repliesIri.href,
      baseUrl: baseUrlString,
      originHost,
      depth,
      status: "pending" as const,
      attempts: 0,
      fetchedItems: 0,
      nextAttemptAt: now,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updated: now,
    };

    const targetJob =
      existingJob ??
      (
        await tx
          .insert(remoteReplyScrapeJobs)
          .values({
            ...values,
            id: uuidv7(),
            created: now,
          })
          .onConflictDoNothing({
            target: remoteReplyScrapeJobs.repliesIri,
          })
          .returning()
      )[0];

    if (targetJob == null) {
      const conflictingJob = await tx.query.remoteReplyScrapeJobs.findFirst({
        where: eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href),
      });

      if (
        conflictingJob == null ||
        isActiveOrCoolingDown(conflictingJob, cooldownStartedAt)
      ) {
        return;
      }

      await tx
        .update(remoteReplyScrapeJobs)
        .set(values)
        .where(eq(remoteReplyScrapeJobs.id, conflictingJob.id));
    } else if (existingJob != null) {
      await tx
        .update(remoteReplyScrapeJobs)
        .set(values)
        .where(eq(remoteReplyScrapeJobs.id, targetJob.id));
    }
  });
}

export async function countActiveRemoteReplyScrapeJobs(
  db: Database,
  repliesIri: URL,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(remoteReplyScrapeJobs)
    .where(
      and(
        eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href),
        inArray(remoteReplyScrapeJobs.status, ["pending", "processing"]),
      ),
    );
  return row?.count ?? 0;
}

function isActiveOrCoolingDown(
  job: RemoteReplyScrapeJob,
  cooldownStartedAt: Date,
): boolean {
  return (
    job.status === "pending" ||
    job.status === "processing" ||
    (job.status === "completed" &&
      job.completedAt != null &&
      job.completedAt > cooldownStartedAt)
  );
}

function parsePositiveInteger(name: string, fallback: number): number {
  const value = parseInteger(name, fallback);
  return value < 1 ? fallback : value;
}

function parseNonNegativeInteger(name: string, fallback: number): number {
  const value = parseInteger(name, fallback);
  return value < 0 ? fallback : value;
}

function parseInteger(name: string, fallback: number): number {
  // oxlint-disable-next-line typescript/dot-notation
  const envValue = process.env[name];
  if (envValue == null || envValue.trim() === "") return fallback;
  const value = Number.parseInt(envValue, 10);
  return Number.isInteger(value) ? value : fallback;
}

export function laterBySeconds(seconds: number, from = new Date()): Date {
  return new Date(from.getTime() + seconds * 1000);
}
