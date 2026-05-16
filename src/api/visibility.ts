import { and, eq, exists, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db, postgres } from "../db";
import { follows, mentions, posts } from "../schema";
import type { Uuid } from "../uuid";

// postgres-js needs the array type OID here; 2951 is uuid[].
const UUID_ARRAY_OID = 2951;

export type PostVisibilityScope = {
  viewerAccountId: Uuid | null;
  followingAccountIds: Uuid[];
};

export async function getApprovedFollowingAccountIds(
  accountId: Uuid,
): Promise<Uuid[]> {
  const rows = await db
    .select({ id: follows.followingId })
    .from(follows)
    .where(and(eq(follows.followerId, accountId), isNotNull(follows.approved)));

  return rows.map((row) => row.id);
}

export function postAccountIdInArray(accountIds: Uuid[], table = posts) {
  return sql`${table.accountId} = ANY(${postgres.array(accountIds, UUID_ARRAY_OID)})`;
}

export async function getPostVisibilityScope(
  viewerAccountId: Uuid | null | undefined,
): Promise<PostVisibilityScope> {
  if (viewerAccountId == null) {
    return { viewerAccountId: null, followingAccountIds: [] };
  }

  return {
    viewerAccountId,
    followingAccountIds: await getApprovedFollowingAccountIds(viewerAccountId),
  };
}

export function buildPostVisibilityConditions(
  scope: PostVisibilityScope,
  table = posts,
) {
  const { viewerAccountId } = scope;

  if (viewerAccountId == null) {
    return inArray(table.visibility, ["public", "unlisted"]);
  }

  const privateAccountIds = [
    ...new Set([viewerAccountId, ...scope.followingAccountIds]),
  ];
  const recipientCondition = or(
    eq(table.accountId, viewerAccountId),
    exists(
      db
        .select({ postId: mentions.postId })
        .from(mentions)
        .where(
          and(
            eq(mentions.postId, table.id),
            eq(mentions.accountId, viewerAccountId),
          ),
        ),
    ),
  );

  return or(
    inArray(table.visibility, ["public", "unlisted"]),
    and(
      eq(table.visibility, "private"),
      or(postAccountIdInArray(privateAccountIds, table), recipientCondition),
    ),
    and(eq(table.visibility, "direct"), recipientCondition),
  );
}
