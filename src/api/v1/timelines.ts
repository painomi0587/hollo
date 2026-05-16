import { zValidator } from "@hono/zod-validator";
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import { getPostRelations, serializePost } from "../../entities/status";
import {
  TIMELINE_INBOX_LIMIT,
  TIMELINE_INBOXES,
} from "../../federation/timeline";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import {
  accountOwners,
  blocks,
  listMembers,
  listPosts,
  lists,
  mentions,
  mutes,
  timelinePosts,
} from "../../schema";
import { isUuid, uuid, type Uuid } from "../../uuid";
import {
  getApprovedFollowingAccountIds,
  postAccountIdInArray,
} from "../visibility";

const app = new Hono<{ Variables: AccountOwnerVariables }>();

app.use(tokenRequired);

export const timelineQuerySchema = z.object({
  max_id: uuid.optional(),
  since_id: uuid.optional(),
  min_id: uuid.optional(),
  limit: z
    .string()
    .default("20")
    .transform((v) => Number.parseInt(v, 10)),
});

export const publicTimelineQuerySchema = timelineQuerySchema.extend({
  local: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  remote: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

// Mastodon pagination semantics shared by every timeline endpoint:
// `min_id` returns the posts *immediately* newer than the cursor (ASC +
// reverse to newest-first); `since_id` is applied only when `min_id` is
// absent and keeps the normal DESC order.
function resolveTimelineCursor(query: { min_id?: Uuid; since_id?: Uuid }): {
  useMinId: boolean;
  lowerBound: Uuid | undefined;
} {
  return {
    useMinId: query.min_id != null,
    lowerBound: query.min_id ?? query.since_id,
  };
}

// Build Mastodon-compatible bidirectional pagination Link header for a
// timeline response.  `timeline` must be ordered newest-first (DESC by id).
function buildTimelineLinkHeader(
  requestUrl: string,
  timeline: readonly { id: Uuid }[],
  limit: number,
): { Link: string } | undefined {
  if (timeline.length === 0) return undefined;
  const baseUrl = new URL(requestUrl);
  baseUrl.searchParams.delete("max_id");
  baseUrl.searchParams.delete("min_id");
  baseUrl.searchParams.delete("since_id");
  const linkParts: string[] = [];
  if (timeline.length >= limit) {
    const next = new URL(baseUrl);
    next.searchParams.set("max_id", timeline[timeline.length - 1].id);
    linkParts.push(`<${next.href}>; rel="next"`);
  }
  const prev = new URL(baseUrl);
  prev.searchParams.set("min_id", timeline[0].id);
  linkParts.push(`<${prev.href}>; rel="prev"`);
  return { Link: linkParts.join(", ") };
}

app.get(
  "/public",
  withAccountOwner,
  zValidator("query", publicTimelineQuerySchema),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    const timeline = await db.query.posts.findMany({
      where: {
        RAW: (
          posts,
          { and, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql },
        ) =>
          and(
            eq(posts.visibility, "public"),
            query.local
              ? inArray(
                  posts.accountId,
                  db.select({ id: accountOwners.id }).from(accountOwners),
                )
              : undefined,
            query.remote
              ? notInArray(
                  posts.accountId,
                  db.select({ id: accountOwners.id }).from(accountOwners),
                )
              : undefined,
            // Hide future posts
            lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
            // Hide the posts from the muted accounts:
            notInArray(
              posts.accountId,
              db
                .select({ accountId: mutes.mutedAccountId })
                .from(mutes)
                .where(
                  and(
                    eq(mutes.accountId, owner.id),
                    or(
                      isNull(mutes.duration),
                      gt(
                        sql`${mutes.created} + ${mutes.duration}`,
                        sql`CURRENT_TIMESTAMP`,
                      ),
                    ),
                  ),
                ),
            ),
            // Hide the posts from the blocked accounts:
            notInArray(
              posts.accountId,
              db
                .select({ accountId: blocks.blockedAccountId })
                .from(blocks)
                .where(eq(blocks.accountId, owner.id)),
            ),
            // Hide the posts from the accounts who blocked the owner:
            notInArray(
              posts.accountId,
              db
                .select({ accountId: blocks.accountId })
                .from(blocks)
                .where(eq(blocks.blockedAccountId, owner.id)),
            ),
            // Hide the shared posts from the muted accounts:
            or(
              isNull(posts.sharingId),
              notInArray(
                posts.sharingId,
                db
                  .select({ id: posts.id })
                  .from(posts)
                  .innerJoin(mutes, eq(mutes.mutedAccountId, posts.accountId))
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
            ),
            // Hide the shared posts from the blocked accounts:
            or(
              isNull(posts.sharingId),
              notInArray(
                posts.sharingId,
                db
                  .select({ id: posts.id })
                  .from(posts)
                  .innerJoin(
                    blocks,
                    eq(blocks.blockedAccountId, posts.accountId),
                  )
                  .where(eq(blocks.accountId, owner.id)),
              ),
            ),
            // Hide the shared posts from the accounts who blocked the owner:
            or(
              isNull(posts.sharingId),
              notInArray(
                posts.sharingId,
                db
                  .select({ id: posts.id })
                  .from(posts)
                  .innerJoin(blocks, eq(blocks.accountId, posts.accountId))
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
            ),
            query.max_id == null ? undefined : lt(posts.id, query.max_id),
            lowerBound == null ? undefined : gt(posts.id, lowerBound),
          )!,
      },
      with: getPostRelations(owner.id),
      orderBy: (posts, { asc, desc }) => [
        useMinId ? asc(posts.id) : desc(posts.id),
      ],
      limit: query.limit,
    });
    if (useMinId) timeline.reverse();
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline, query.limit),
    );
  },
);

app.get(
  "/home",
  scopeRequired(["read:statuses"]),
  withAccountOwner,
  zValidator("query", timelineQuerySchema),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    let timeline: Parameters<typeof serializePost>[0][];
    if (TIMELINE_INBOXES) {
      timeline = await db.query.posts.findMany({
        where: {
          RAW: (
            posts,
            { and, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql },
          ) =>
            and(
              inArray(
                posts.id,
                db
                  .select({ id: timelinePosts.postId })
                  .from(timelinePosts)
                  .where(
                    and(
                      eq(timelinePosts.accountId, owner.id),
                      query.max_id == null
                        ? undefined
                        : lt(timelinePosts.postId, query.max_id),
                      lowerBound == null
                        ? undefined
                        : gt(timelinePosts.postId, lowerBound),
                    ),
                  )
                  .orderBy(
                    useMinId
                      ? asc(timelinePosts.postId)
                      : desc(timelinePosts.postId),
                  )
                  .limit(Math.min(TIMELINE_INBOX_LIMIT, query.limit)),
              ),
              // Hide future posts
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
              // Hide the posts from the muted accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: mutes.mutedAccountId })
                  .from(mutes)
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
              // Hide the posts from the blocked accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.blockedAccountId })
                  .from(blocks)
                  .where(eq(blocks.accountId, owner.id)),
              ),
              // Hide the posts from the accounts who blocked the owner:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.accountId })
                  .from(blocks)
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
              // Hide the shared posts from the muted accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(mutes, eq(mutes.mutedAccountId, posts.accountId))
                    .where(
                      and(
                        eq(mutes.accountId, owner.id),
                        or(
                          isNull(mutes.duration),
                          gt(
                            sql`${mutes.created} + ${mutes.duration}`,
                            sql`CURRENT_TIMESTAMP`,
                          ),
                        ),
                      ),
                    ),
                ),
              ),
              // Hide the shared posts from the blocked accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(
                      blocks,
                      eq(blocks.blockedAccountId, posts.accountId),
                    )
                    .where(eq(blocks.accountId, owner.id)),
                ),
              ),
              // Hide the shared posts from the accounts who blocked the owner:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(blocks, eq(blocks.accountId, posts.accountId))
                    .where(eq(blocks.blockedAccountId, owner.id)),
                ),
              ),
            )!,
        },
        with: getPostRelations(owner.id),
        orderBy: (posts, { asc, desc }) => [
          useMinId ? asc(posts.id) : desc(posts.id),
        ],
        limit: query.limit,
      });
    } else {
      const followingAccountIds = await getApprovedFollowingAccountIds(
        owner.id,
      );
      const followedTags: SQL[] = owner.followedTags.map(
        // oxlint-disable-next-line prefer-template
        (t) => sql`${"#" + t}`,
      );
      timeline = await db.query.posts.findMany({
        where: {
          RAW: (
            posts,
            { and, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql },
          ) =>
            and(
              or(
                eq(posts.accountId, owner.id),
                and(
                  ne(posts.visibility, "direct"),
                  postAccountIdInArray(followingAccountIds, posts),
                  notInArray(
                    posts.accountId,
                    db
                      .select({ id: listMembers.accountId })
                      .from(listMembers)
                      .leftJoin(lists, eq(listMembers.listId, lists.id))
                      .where(eq(lists.exclusive, true)),
                  ),
                ),
                and(
                  ne(posts.visibility, "private"),
                  inArray(
                    posts.id,
                    db
                      .select({ id: mentions.postId })
                      .from(mentions)
                      .where(eq(mentions.accountId, owner.id)),
                  ),
                ),
                owner.followedTags.length < 1
                  ? undefined
                  : and(
                      eq(posts.visibility, "public"),
                      sql`${posts.tags} ?| ARRAY[${sql.join(
                        followedTags,
                        sql.raw(","),
                      )}]`,
                    ),
              ),
              or(
                isNull(posts.replyTargetId),
                inArray(
                  posts.replyTargetId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .where(
                      or(
                        eq(posts.accountId, owner.id),
                        postAccountIdInArray(followingAccountIds, posts),
                      ),
                    ),
                ),
              ),
              // Hide future posts
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
              // Hide the posts from the muted accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: mutes.mutedAccountId })
                  .from(mutes)
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
              // Hide the posts from the blocked accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.blockedAccountId })
                  .from(blocks)
                  .where(eq(blocks.accountId, owner.id)),
              ),
              // Hide the posts from the accounts who blocked the owner:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.accountId })
                  .from(blocks)
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
              // Hide the shared posts from the muted accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(mutes, eq(mutes.mutedAccountId, posts.accountId))
                    .where(
                      and(
                        eq(mutes.accountId, owner.id),
                        or(
                          isNull(mutes.duration),
                          gt(
                            sql`${mutes.created} + ${mutes.duration}`,
                            sql`CURRENT_TIMESTAMP`,
                          ),
                        ),
                      ),
                    ),
                ),
              ),
              // Hide the shared posts from the blocked accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(
                      blocks,
                      eq(blocks.blockedAccountId, posts.accountId),
                    )
                    .where(eq(blocks.accountId, owner.id)),
                ),
              ),
              // Hide the shared posts from the accounts who blocked the owner:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(blocks, eq(blocks.accountId, posts.accountId))
                    .where(eq(blocks.blockedAccountId, owner.id)),
                ),
              ),
              query.max_id == null ? undefined : lt(posts.id, query.max_id),
              lowerBound == null ? undefined : gt(posts.id, lowerBound),
            )!,
        },
        with: getPostRelations(owner.id),
        orderBy: (posts, { asc, desc }) => [
          useMinId ? asc(posts.id) : desc(posts.id),
        ],
        limit: query.limit,
      });
    }
    if (useMinId) timeline.reverse();
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline, query.limit),
    );
  },
);

app.get(
  "/list/:list_id",
  tokenRequired,
  scopeRequired(["read:lists"]),
  withAccountOwner,
  zValidator("query", publicTimelineQuerySchema),
  async (c) => {
    const listId = c.req.param("list_id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const list = await db.query.lists.findFirst({
      where: {
        RAW: (lists, { and, eq }) =>
          and(eq(lists.id, listId), eq(lists.accountOwnerId, owner.id))!,
      },
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    let timeline: Parameters<typeof serializePost>[0][];
    if (TIMELINE_INBOXES) {
      timeline = await db.query.posts.findMany({
        where: {
          RAW: (
            posts,
            { and, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql },
          ) =>
            and(
              inArray(
                posts.id,
                db
                  .select({ id: listPosts.postId })
                  .from(listPosts)
                  .where(
                    and(
                      eq(listPosts.listId, list.id),
                      query.max_id == null
                        ? undefined
                        : lt(listPosts.postId, query.max_id),
                      lowerBound == null
                        ? undefined
                        : gt(listPosts.postId, lowerBound),
                    ),
                  )
                  .orderBy(
                    useMinId ? asc(listPosts.postId) : desc(listPosts.postId),
                  )
                  .limit(Math.min(TIMELINE_INBOX_LIMIT, query.limit)),
              ),
              // Hide future posts
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
              // Hide the posts from the muted accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: mutes.mutedAccountId })
                  .from(mutes)
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
              // Hide the posts from the blocked accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.blockedAccountId })
                  .from(blocks)
                  .where(eq(blocks.accountId, owner.id)),
              ),
              // Hide the posts from the accounts who blocked the owner:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.accountId })
                  .from(blocks)
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
              // Hide the shared posts from the muted accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(mutes, eq(mutes.mutedAccountId, posts.accountId))
                    .where(
                      and(
                        eq(mutes.accountId, owner.id),
                        or(
                          isNull(mutes.duration),
                          gt(
                            sql`${mutes.created} + ${mutes.duration}`,
                            sql`CURRENT_TIMESTAMP`,
                          ),
                        ),
                      ),
                    ),
                ),
              ),
              // Hide the shared posts from the blocked accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(
                      blocks,
                      eq(blocks.blockedAccountId, posts.accountId),
                    )
                    .where(eq(blocks.accountId, owner.id)),
                ),
              ),
              // Hide the shared posts from the accounts who blocked the owner:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(blocks, eq(blocks.accountId, posts.accountId))
                    .where(eq(blocks.blockedAccountId, owner.id)),
                ),
              ),
            )!,
        },
        with: getPostRelations(owner.id),
        orderBy: (posts, { asc, desc }) => [
          useMinId ? asc(posts.id) : desc(posts.id),
        ],
        limit: query.limit,
      });
    } else {
      const followingAccountIds = await getApprovedFollowingAccountIds(
        owner.id,
      );
      timeline = await db.query.posts.findMany({
        where: {
          RAW: (
            posts,
            { and, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql },
          ) =>
            and(
              ne(posts.visibility, "direct"),
              inArray(
                posts.accountId,
                db
                  .select({ id: listMembers.accountId })
                  .from(listMembers)
                  .where(eq(listMembers.listId, list.id)),
              ),
              or(
                isNull(posts.replyTargetId),
                list.repliesPolicy === "none"
                  ? undefined
                  : inArray(
                      posts.replyTargetId,
                      db
                        .select({ id: posts.id })
                        .from(posts)
                        .where(
                          or(
                            eq(posts.accountId, owner.id),
                            list.repliesPolicy === "followed"
                              ? postAccountIdInArray(followingAccountIds, posts)
                              : inArray(
                                  posts.accountId,
                                  db
                                    .select({ id: listMembers.accountId })
                                    .from(listMembers)
                                    .where(eq(listMembers.listId, list.id)),
                                ),
                          ),
                        ),
                    ),
              ),
              // Hide future posts
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
              // Hide the posts from the muted accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: mutes.mutedAccountId })
                  .from(mutes)
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
              // Hide the posts from the blocked accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.blockedAccountId })
                  .from(blocks)
                  .where(eq(blocks.accountId, owner.id)),
              ),
              // Hide the posts from the accounts who blocked the owner:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.accountId })
                  .from(blocks)
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
              // Hide the shared posts from the muted accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(mutes, eq(mutes.mutedAccountId, posts.accountId))
                    .where(
                      and(
                        eq(mutes.accountId, owner.id),
                        or(
                          isNull(mutes.duration),
                          gt(
                            sql`${mutes.created} + ${mutes.duration}`,
                            sql`CURRENT_TIMESTAMP`,
                          ),
                        ),
                      ),
                    ),
                ),
              ),
              // Hide the shared posts from the blocked accounts:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(
                      blocks,
                      eq(blocks.blockedAccountId, posts.accountId),
                    )
                    .where(eq(blocks.accountId, owner.id)),
                ),
              ),
              // Hide the shared posts from the accounts who blocked the owner:
              or(
                isNull(posts.sharingId),
                notInArray(
                  posts.sharingId,
                  db
                    .select({ id: posts.id })
                    .from(posts)
                    .innerJoin(blocks, eq(blocks.accountId, posts.accountId))
                    .where(eq(blocks.blockedAccountId, owner.id)),
                ),
              ),
              query.max_id == null ? undefined : lt(posts.id, query.max_id),
              lowerBound == null ? undefined : gt(posts.id, lowerBound),
            )!,
        },
        with: getPostRelations(owner.id),
        orderBy: (posts, { asc, desc }) => [
          useMinId ? asc(posts.id) : desc(posts.id),
        ],
        limit: query.limit,
      });
    }
    if (useMinId) timeline.reverse();
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline, query.limit),
    );
  },
);

app.get(
  "/tag/:hashtag",
  tokenRequired,
  scopeRequired(["read:statuses"]),
  withAccountOwner,
  zValidator("query", publicTimelineQuerySchema),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const hashtag = `#${c.req.param("hashtag")}`;
    const followingAccountIds = await getApprovedFollowingAccountIds(owner.id);
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    const timeline = await db.query.posts.findMany({
      where: {
        RAW: (
          posts,
          { and, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql },
        ) =>
          and(
            or(
              eq(posts.accountId, owner.id),
              and(
                ne(posts.visibility, "direct"),
                postAccountIdInArray(followingAccountIds, posts),
              ),
              and(
                ne(posts.visibility, "private"),
                inArray(
                  posts.id,
                  db
                    .select({ id: mentions.postId })
                    .from(mentions)
                    .where(eq(mentions.accountId, owner.id)),
                ),
              ),
            ),
            sql`${posts.tags} ? ${hashtag.toLowerCase()}`,
            query.local
              ? inArray(
                  posts.accountId,
                  db.select({ id: accountOwners.id }).from(accountOwners),
                )
              : undefined,
            query.remote
              ? notInArray(
                  posts.accountId,
                  db.select({ id: accountOwners.id }).from(accountOwners),
                )
              : undefined,
            // Hide future posts
            lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
            // Hide the posts from the muted accounts:
            notInArray(
              posts.accountId,
              db
                .select({ accountId: mutes.mutedAccountId })
                .from(mutes)
                .where(
                  and(
                    eq(mutes.accountId, owner.id),
                    or(
                      isNull(mutes.duration),
                      gt(
                        sql`${mutes.created} + ${mutes.duration}`,
                        sql`CURRENT_TIMESTAMP`,
                      ),
                    ),
                  ),
                ),
            ),
            // Hide the posts from the blocked accounts:
            notInArray(
              posts.accountId,
              db
                .select({ accountId: blocks.blockedAccountId })
                .from(blocks)
                .where(eq(blocks.accountId, owner.id)),
            ),
            // Hide the posts from the accounts who blocked the owner:
            notInArray(
              posts.accountId,
              db
                .select({ accountId: blocks.accountId })
                .from(blocks)
                .where(eq(blocks.blockedAccountId, owner.id)),
            ),
            query.max_id == null ? undefined : lt(posts.id, query.max_id),
            lowerBound == null ? undefined : gt(posts.id, lowerBound),
          )!,
      },
      with: getPostRelations(owner.id),
      orderBy: (posts, { asc, desc }) => [
        useMinId ? asc(posts.id) : desc(posts.id),
      ],
      limit: query.limit,
    });
    if (useMinId) timeline.reverse();
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline, query.limit),
    );
  },
);

export default app;
