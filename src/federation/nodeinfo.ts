import type { NodeInfo } from "@fedify/fedify";
import { and, count, eq, exists, gt, sql } from "drizzle-orm";

import metadata from "../../package.json" with { type: "json" };
import { db } from "../db";
import { accountOwners, posts } from "../schema";
import { federation } from "./federation";

let cache: { body: NodeInfo; expires: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function computeNodeInfo(): Promise<NodeInfo> {
  const [{ total }] = await db.select({ total: count() }).from(accountOwners);
  const [{ activeMonth }] = await db
    .select({ activeMonth: count() })
    .from(accountOwners)
    .where(
      exists(
        db
          .select({ one: sql`1` })
          .from(posts)
          .where(
            and(
              eq(posts.accountId, accountOwners.id),
              gt(posts.updated, sql`CURRENT_TIMESTAMP - INTERVAL '1 month'`),
            ),
          ),
      ),
    );
  const [{ activeHalfyear }] = await db
    .select({ activeHalfyear: count() })
    .from(accountOwners)
    .where(
      exists(
        db
          .select({ one: sql`1` })
          .from(posts)
          .where(
            and(
              eq(posts.accountId, accountOwners.id),
              gt(posts.updated, sql`CURRENT_TIMESTAMP - INTERVAL '6 months'`),
            ),
          ),
      ),
    );
  const [{ localPosts, localComments }] = await db
    .select({
      localPosts:
        sql<number>`count(*) filter (where ${posts.replyTargetId} is null)`.mapWith(
          Number,
        ),
      localComments:
        sql<number>`count(*) filter (where ${posts.replyTargetId} is not null)`.mapWith(
          Number,
        ),
    })
    .from(posts)
    .innerJoin(accountOwners, eq(posts.accountId, accountOwners.id));
  return {
    software: {
      name: "hollo",
      version: metadata.version,
      homepage: new URL("https://docs.hollo.social/"),
      repository: new URL("https://github.com/fedify-dev/hollo"),
    },
    protocols: ["activitypub"],
    services: {
      outbound: ["atom1.0"],
    },
    usage: {
      users: {
        total,
        activeMonth,
        activeHalfyear,
      },
      localComments,
      localPosts,
    },
  };
}

federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (_ctx) => {
  if (cache != null && cache.expires > Date.now()) return cache.body;
  const body = await computeNodeInfo();
  cache = { body, expires: Date.now() + TTL_MS };
  return body;
});

// cSpell: ignore halfyear
