import { Temporal } from "@js-temporal/polyfill";
import { getLogger } from "@logtape/logtape";
import { and, count, eq, exists, ilike, lt, not, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";

import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import { loginRequired } from "../login";
import {
  accountOwners,
  accounts,
  bookmarks,
  likes,
  media,
  posts,
  reactions,
} from "../schema";
import { drive } from "../storage";
import { STORAGE_URL_BASE } from "../storage-config";
import type { Uuid } from "../uuid";

const logger = getLogger(["hollo", "pages", "thumbnail_cleanup"]);

const data = new Hono();

data.use(loginRequired);

data.get("/", async (c) => {
  const done = c.req.query("done");
  const error = c.req.query("error");
  const before = c.req.query("before");
  const fileCount = c.req.query("fileCount");
  const firstFile = c.req.query("firstFile");
  const lastFile = c.req.query("lastFile");
  const todo = c.req.query("todo");
  const processed = c.req.query("processed");
  const deleted = c.req.query("deleted");

  const suggestedCleanupCutoff =
    typeof before === "string"
      ? before
      : new Date(new Date().getFullYear() - 1, 0, 1)
          .toISOString()
          .split("T")[0];

  const sharingPosts = alias(posts, "sharingPosts");
  const quotingPosts = alias(posts, "quotingPosts");

  let thumbnailsBeforeLastYearAndOnlyMaybeRepliedResult: { count: number }[];
  try {
    thumbnailsBeforeLastYearAndOnlyMaybeRepliedResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .innerJoin(posts, eq(media.postId, posts.id))
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
          lt(media.created, new Date(new Date().getFullYear() - 1, 0, 1)),
          notExists(
            db
              .select()
              .from(accountOwners)
              .where(eq(accounts.id, accountOwners.id)),
          ),
          notExists(
            db.select().from(bookmarks).where(eq(posts.id, bookmarks.postId)),
          ),
          notExists(
            db
              .select()
              .from(likes)
              .where(
                and(
                  eq(posts.id, likes.postId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(likes.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select()
              .from(reactions)
              .where(
                and(
                  eq(posts.id, reactions.postId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(reactions.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select()
              .from(sharingPosts)
              .where(
                and(
                  eq(posts.id, sharingPosts.sharingId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(sharingPosts.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select()
              .from(quotingPosts)
              .where(
                and(
                  eq(posts.id, quotingPosts.quoteTargetId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(quotingPosts.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
        ),
      );
  } catch {
    thumbnailsBeforeLastYearAndOnlyMaybeRepliedResult = [{ count: 0 }];
  }
  const thumbnailsBeforeLastYearAndOnlyMaybeRepliedCount =
    thumbnailsBeforeLastYearAndOnlyMaybeRepliedResult[0].count;

  let thumbnailsBeforeLastYearResult: { count: number }[];
  try {
    thumbnailsBeforeLastYearResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .innerJoin(posts, eq(media.postId, posts.id))
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
          lt(media.created, new Date(new Date().getFullYear() - 1, 0, 1)),
          notExists(
            db
              .select()
              .from(accountOwners)
              .where(eq(accounts.id, accountOwners.id)),
          ),
        ),
      );
  } catch {
    thumbnailsBeforeLastYearResult = [{ count: 0 }];
  }
  const thumbnailsBeforeLastYearCount = thumbnailsBeforeLastYearResult[0].count;

  const oneYearAgo = new Date(
    Temporal.Now.zonedDateTimeISO().subtract(new Temporal.Duration(1))
      .epochMilliseconds,
  );

  let thumbnailsYearOldAndOnlyMaybeRepliedResult: { count: number }[];
  try {
    thumbnailsYearOldAndOnlyMaybeRepliedResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .innerJoin(posts, eq(media.postId, posts.id))
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
          lt(media.created, oneYearAgo),
          notExists(
            db
              .select()
              .from(accountOwners)
              .where(eq(accounts.id, accountOwners.id)),
          ),
          notExists(
            db.select().from(bookmarks).where(eq(posts.id, bookmarks.postId)),
          ),
          notExists(
            db
              .select()
              .from(likes)
              .where(
                and(
                  eq(posts.id, likes.postId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(likes.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select()
              .from(reactions)
              .where(
                and(
                  eq(posts.id, reactions.postId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(reactions.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select()
              .from(sharingPosts)
              .where(
                and(
                  eq(posts.id, sharingPosts.sharingId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(sharingPosts.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
          notExists(
            db
              .select()
              .from(quotingPosts)
              .where(
                and(
                  eq(posts.id, quotingPosts.quoteTargetId),
                  exists(
                    db
                      .select()
                      .from(accountOwners)
                      .where(eq(quotingPosts.accountId, accountOwners.id)),
                  ),
                ),
              ),
          ),
        ),
      );
  } catch {
    thumbnailsYearOldAndOnlyMaybeRepliedResult = [{ count: 0 }];
  }
  const thumbnailsYearOldAndOnlyMaybeRepliedCount =
    thumbnailsYearOldAndOnlyMaybeRepliedResult[0].count;

  let thumbnailsYearOldResult: { count: number }[];
  try {
    thumbnailsYearOldResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .innerJoin(posts, eq(media.postId, posts.id))
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
          lt(media.created, oneYearAgo),
          notExists(
            db
              .select()
              .from(accountOwners)
              .where(eq(accounts.id, accountOwners.id)),
          ),
        ),
      );
  } catch {
    thumbnailsYearOldResult = [{ count: 0 }];
  }
  const thumbnailsYearOldCount = thumbnailsYearOldResult[0].count;

  let remoteThumbnailsResult: { count: number }[];
  try {
    remoteThumbnailsResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .innerJoin(posts, eq(media.postId, posts.id))
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
          notExists(
            db
              .select()
              .from(accountOwners)
              .where(eq(accounts.id, accountOwners.id)),
          ),
        ),
      );
  } catch {
    remoteThumbnailsResult = [{ count: 0 }];
  }
  const thumbnailsRemoteCount = remoteThumbnailsResult[0].count;

  let thumbnailsCountResult: { count: number }[];
  try {
    thumbnailsCountResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
        ),
      );
  } catch {
    thumbnailsCountResult = [{ count: 0 }];
  }
  const thumbnailsCount = thumbnailsCountResult[0].count;

  const thumbnailsTable: { caption: string; count: number }[] = [
    { caption: "Total, thumbnail hosted locally", count: thumbnailsCount },
    {
      caption: "Remote, thumbnail hosted locally",
      count: thumbnailsRemoteCount,
    },
    {
      caption: "From before 1 year ago, remote, thumbnail hosted locally",
      count: thumbnailsYearOldCount,
    },
    {
      caption:
        "From before 1 year ago, remote, thumbnail hosted locally, not interacted with outside of maybe replying",
      count: thumbnailsYearOldAndOnlyMaybeRepliedCount,
    },
    {
      caption: "From before last year, remote, thumbnail hosted locally",
      count: thumbnailsBeforeLastYearCount,
    },
    {
      caption:
        "From before last year, remote, thumbnail hosted locally, not interacted with outside of maybe replying",
      count: thumbnailsBeforeLastYearAndOnlyMaybeRepliedCount,
    },
  ];

  return c.html(
    <DashboardLayout
      title="Hollo: Thumbnail Cleanup"
      selectedMenu="thumbnail_cleanup"
    >
      <hgroup>
        <h1>Thumbnail Cleanup</h1>
        <p>This control panel allows you to clean up thumbnails.</p>
      </hgroup>

      <article>
        <header>
          <hgroup>
            <h2>Thumbnail statistics</h2>
            <p>An overview about the number of thumbnails tracked by hollo.</p>
          </hgroup>
        </header>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th style="text-align: right">Number of thumbnails</th>
            </tr>
          </thead>
          <tbody>
            {thumbnailsTable.map((entry) => (
              <tr>
                <td>{entry.caption}</td>
                <td style="text-align: right">
                  {entry.count.toLocaleString("en")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
      <article>
        <header>
          <hgroup>
            <h2>Preview cleanup</h2>
            {done === "clean_preview" ? (
              <p>Preview done.</p>
            ) : (
              <p>Use this to preview the cleanup.</p>
            )}
          </hgroup>
        </header>
        <form
          method="post"
          action="/thumbnail_cleanup/clean_preview"
          onsubmit="this.submit.ariaBusy = 'true'"
        >
          <fieldset role="group">
            <input
              type="date"
              name="before"
              value={suggestedCleanupCutoff}
              required
              aria-invalid={error === "clean" ? "true" : undefined}
            />
            <button name="submit" type="submit">
              clean
            </button>
          </fieldset>
          {error === "clean_preview" ? (
            <small>Something went wrong while cleaning up.</small>
          ) : (
            <small>The date before which remote thumbnails get deleted.</small>
          )}
        </form>
        {done === "clean_preview" && (
          <p>
            Number of Items: {fileCount}
            <br />
            First: {firstFile}
            <br />
            Last: {lastFile}
            <br />
          </p>
        )}
      </article>
      <article>
        <header>
          <hgroup>
            <h2>Clean up thumbnails</h2>
            {done === "clean" ? (
              <p>Thumbnails have been cleaned up.</p>
            ) : (
              <p>
                Use this when you want to free up storage by deleting old
                thumbnails.
              </p>
            )}
          </hgroup>
        </header>
        <form
          method="post"
          action="/thumbnail_cleanup/clean"
          onsubmit="this.submit.ariaBusy = 'true'"
        >
          <fieldset role="group">
            <input
              type="date"
              name="before"
              value={suggestedCleanupCutoff}
              required
              aria-invalid={error === "clean" ? "true" : undefined}
            />
            <button name="submit" type="submit">
              clean
            </button>
          </fieldset>
          {error === "clean" ? (
            <small>Something went wrong while cleaning up.</small>
          ) : (
            <small>The date before which remote thumbnails get deleted.</small>
          )}
        </form>
        {(done === "clean" || error === "clean") && (
          <p>
            Number of Items in Range: {todo}
            <br />
            Processed: {processed}
            <br />
            Actually deleted: {deleted}
            <br />
          </p>
        )}
      </article>
    </DashboardLayout>,
  );
});

function readFilesToDelete(
  before: Date,
  keyPrefix: string,
): Promise<{ id: Uuid; thumbnailUrl: string; created: Date }[]> {
  const sharingPosts = alias(posts, "sharingPosts");
  const quotingPosts = alias(posts, "quotingPosts");

  return db
    .select({
      id: media.id,
      thumbnailUrl: media.thumbnailUrl,
      created: media.created,
    })
    .from(media)
    .innerJoin(posts, eq(media.postId, posts.id))
    .innerJoin(accounts, eq(posts.accountId, accounts.id))
    .where(
      and(
        not(media.thumbnailCleaned),
        ilike(media.thumbnailUrl, `${keyPrefix}%`),
        lt(media.created, before),
        notExists(
          db
            .select()
            .from(accountOwners)
            .where(eq(accounts.id, accountOwners.id)),
        ),
        notExists(
          db.select().from(bookmarks).where(eq(posts.id, bookmarks.postId)),
        ),
        notExists(
          db
            .select()
            .from(likes)
            .where(
              and(
                eq(posts.id, likes.postId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(likes.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select()
            .from(reactions)
            .where(
              and(
                eq(posts.id, reactions.postId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(reactions.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select()
            .from(sharingPosts)
            .where(
              and(
                eq(posts.id, sharingPosts.sharingId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(sharingPosts.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select()
            .from(quotingPosts)
            .where(
              and(
                eq(posts.id, quotingPosts.quoteTargetId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(quotingPosts.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(media.created);
}

data.post("/clean_preview", async (c) => {
  const form = await c.req.formData();
  var beforeParameter = form.get("before");
  if (typeof beforeParameter === "string") {
    const before = new Date(Date.parse(beforeParameter));
    const owner = await db.query.accountOwners.findFirst({});
    if (owner != null && STORAGE_URL_BASE !== undefined) {
      logger.info(`Starting cleanup preview - before: ${before.toISOString()}`);
      try {
        const mediaToDelete: { id: Uuid; key: string | null; created: Date }[] =
          (await readFilesToDelete(before, STORAGE_URL_BASE)).map((row) => ({
            id: row.id,
            key: row.thumbnailUrl.startsWith(STORAGE_URL_BASE as string)
              ? row.thumbnailUrl.replace(STORAGE_URL_BASE as string, "")
              : null,
            created: row.created,
          }));

        logger.info(`would be about to delete ${mediaToDelete.length} files!`);
        const firstItem = mediaToDelete[0];
        const lastItem = mediaToDelete[mediaToDelete.length - 1];
        logger.info(
          `first file would have id ${firstItem.id}, key ${firstItem.key}, created at ${firstItem.created}`,
        );
        logger.info(
          `last file would have id ${lastItem.id}, key ${lastItem.key}, created at ${lastItem.created}`,
        );
        const doneUrl: URL = new URL(
          "/thumbnail_cleanup",
          new URL(c.req.url).origin,
        );
        doneUrl.searchParams.set("done", "clean_preview");
        doneUrl.searchParams.set("before", beforeParameter);
        doneUrl.searchParams.set(
          "fileCount",
          mediaToDelete.length.toLocaleString("en"),
        );
        doneUrl.searchParams.set(
          "firstFile",
          firstItem.created.toLocaleString(),
        );
        doneUrl.searchParams.set("lastFile", lastItem.created.toLocaleString());
        return c.redirect(doneUrl);
      } catch (error) {
        logger.error("Failed to clean up: {error}", { error });
      }
    }
  }

  const errorUrl: URL = new URL(
    "/thumbnail_cleanup",
    new URL(c.req.url).origin,
  );
  errorUrl.searchParams.set("error", "clean_preview");
  if (typeof beforeParameter === "string") {
    errorUrl.searchParams.set("before", beforeParameter);
  }
  return c.redirect(errorUrl);
});

data.post("/clean", async (c) => {
  let todoCounter = 0;
  let deletionCounter = 0;
  let processCounter = 0;

  const form = await c.req.formData();
  var beforeParameter = form.get("before");
  if (typeof beforeParameter === "string") {
    const before = new Date(Date.parse(beforeParameter));
    const owner = await db.query.accountOwners.findFirst({});
    if (owner != null && STORAGE_URL_BASE !== undefined) {
      logger.info(`Starting cleanup - before: ${before.toISOString()}`);

      try {
        const mediaToDelete: { id: Uuid; key: string | null; created: Date }[] =
          (await readFilesToDelete(before, STORAGE_URL_BASE)).map((row) => ({
            id: row.id,
            key: row.thumbnailUrl.startsWith(STORAGE_URL_BASE as string)
              ? row.thumbnailUrl.replace(STORAGE_URL_BASE as string, "")
              : null,
            created: row.created,
          }));

        todoCounter = mediaToDelete.length;
        logger.info(`about to delete ${mediaToDelete.length} files!`);
        const firstItem = mediaToDelete[0];
        const lastItem = mediaToDelete[mediaToDelete.length - 1];
        logger.info(
          `first file has id ${firstItem.id}, key ${firstItem.key}, created at ${firstItem.created}`,
        );
        logger.info(
          `last file has id ${lastItem.id}, key ${lastItem.key}, created at ${lastItem.created}`,
        );

        const disk = drive.use();

        // we should report every 5 percent (or at worst every item if it's that few), sounds about good.
        const chunksize = Math.trunc(Math.max(1, todoCounter / 20));

        for (const medium of mediaToDelete) {
          if (medium.key != null) {
            await disk.delete(medium.key);
            await db
              .update(media)
              .set({ thumbnailCleaned: true })
              .where(eq(media.id, medium.id));
            ++deletionCounter;
          }
          ++processCounter;
          if (processCounter % chunksize === 0) {
            logger.info(
              `Thumbnail cleanup ${Math.trunc((processCounter / todoCounter) * 100)}% done (${processCounter}/${todoCounter}, ${deletionCounter} deletions)`,
            );
          }
        }

        logger.info(
          `Cleanup done, ${todoCounter} to do, ${processCounter} processed, ${deletionCounter} deleted!`,
        );

        const doneUrl: URL = new URL(
          "/thumbnail_cleanup",
          new URL(c.req.url).origin,
        );
        doneUrl.searchParams.set("done", "clean");
        doneUrl.searchParams.set("before", beforeParameter);
        doneUrl.searchParams.set("todo", todoCounter.toLocaleString("en"));
        doneUrl.searchParams.set(
          "processed",
          processCounter.toLocaleString("en"),
        );
        doneUrl.searchParams.set(
          "deleted",
          deletionCounter.toLocaleString("en"),
        );
        return c.redirect(doneUrl);
      } catch (error) {
        logger.error("Failed to clean up: {error}", { error });
        logger.info(
          `Cleanup unfinished, ${todoCounter} to do, ${processCounter} processed, ${deletionCounter} deleted!`,
        );
      }
    }
  }

  const errorUrl: URL = new URL(
    "/thumbnail_cleanup",
    new URL(c.req.url).origin,
  );
  errorUrl.searchParams.set("error", "clean");
  errorUrl.searchParams.set("todo", todoCounter.toLocaleString("en"));
  errorUrl.searchParams.set("processed", processCounter.toLocaleString("en"));
  errorUrl.searchParams.set("deleted", deletionCounter.toLocaleString("en"));
  if (typeof beforeParameter === "string") {
    errorUrl.searchParams.set("before", beforeParameter);
  }
  return c.redirect(errorUrl);
});

export default data;
