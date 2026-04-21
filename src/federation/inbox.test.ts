import type { InboxContext } from "@fedify/fedify";
import { Accept, Reject } from "@fedify/vocab";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows } from "../schema";
import type { Uuid } from "../uuid";
import { onFollowAccepted, onFollowRejected } from "./inbox";

type SeededFollow = {
  followerId: Uuid;
  followingId: Uuid;
  followerIri: string;
  followingIri: string;
};

async function seedFollow(): Promise<SeededFollow> {
  const followerOwner = await createAccount({ username: "follower" });
  const followingOwner = await createAccount({ username: "following" });
  const follower = await db.query.accounts.findFirst({
    where: eq(accounts.id, followerOwner.id as Uuid),
  });
  const following = await db.query.accounts.findFirst({
    where: eq(accounts.id, followingOwner.id as Uuid),
  });
  if (follower == null || following == null) {
    throw new Error("Failed to seed accounts");
  }
  const followIri = `${follower.iri}#follows/${crypto.randomUUID()}`;
  await db.insert(follows).values({
    iri: followIri,
    followerId: follower.id,
    followingId: following.id,
    approved: null,
  });
  return {
    followerId: follower.id,
    followingId: following.id,
    followerIri: follower.iri,
    followingIri: following.iri,
  };
}

const ctx = {
  origin: "https://hollo.test",
  recipient: "follower",
} as InboxContext<void>;

describe("onFollowAccepted", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("approves a pending follow from embedded Follow object", async () => {
    expect.assertions(2);

    const seeded = await seedFollow();
    const accept = await Accept.fromJsonLd({
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: `${seeded.followingIri}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: {
        id: seeded.followingIri,
        type: "Person",
        preferredUsername: "following",
        inbox: `${seeded.followingIri}/inbox`,
      },
      object: {
        id: `${seeded.followerIri}#follows/${crypto.randomUUID()}`,
        type: "Follow",
        actor: seeded.followerIri,
        object: seeded.followingIri,
      },
    });

    await onFollowAccepted(ctx, accept);

    const follow = await db.query.follows.findFirst({
      where: and(
        eq(follows.followerId, seeded.followerId),
        eq(follows.followingId, seeded.followingId),
      ),
    });
    expect(follow).toBeDefined();
    expect(follow?.approved).not.toBeNull();
  });

  it("updates the follower's followingCount when approved via embedded Follow object (Path B)", async () => {
    expect.assertions(2);

    const seeded = await seedFollow();

    const followerBefore = await db.query.accounts.findFirst({
      where: eq(accounts.id, seeded.followerId),
    });
    expect(followerBefore?.followingCount).toBe(0);

    // Path B: Accept wraps a Follow object whose id does NOT match any stored
    // follow IRI, so the objectId-based lookup (Path A) finds nothing and falls
    // through to the embedded-object fallback.
    const accept = await Accept.fromJsonLd({
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: `${seeded.followingIri}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: {
        id: seeded.followingIri,
        type: "Person",
        preferredUsername: "following",
        inbox: `${seeded.followingIri}/inbox`,
      },
      object: {
        id: `${seeded.followerIri}#follows/${crypto.randomUUID()}`,
        type: "Follow",
        actor: seeded.followerIri,
        object: seeded.followingIri,
      },
    });

    await onFollowAccepted(ctx, accept);

    const followerAfter = await db.query.accounts.findFirst({
      where: eq(accounts.id, seeded.followerId),
    });
    expect(followerAfter?.followingCount).toBe(1);
  });
});

describe("onFollowRejected", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deletes a pending follow from embedded Follow object", async () => {
    expect.assertions(1);

    const seeded = await seedFollow();
    const reject = await Reject.fromJsonLd({
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: `${seeded.followingIri}#rejects/${crypto.randomUUID()}`,
      type: "Reject",
      actor: {
        id: seeded.followingIri,
        type: "Person",
        preferredUsername: "following",
        inbox: `${seeded.followingIri}/inbox`,
      },
      object: {
        id: `${seeded.followerIri}#follows/${crypto.randomUUID()}`,
        type: "Follow",
        actor: seeded.followerIri,
        object: seeded.followingIri,
      },
    });

    await onFollowRejected(ctx, reject);

    const follow = await db.query.follows.findFirst({
      where: and(
        eq(follows.followerId, seeded.followerId),
        eq(follows.followingId, seeded.followingId),
      ),
    });
    expect(follow).toBeUndefined();
  });
});
