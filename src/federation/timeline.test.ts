import { describe, expect, it } from "vitest";

import {
  shouldExcludePostFromTimeline,
  shouldIncludePostInList,
  shouldIncludePostInTimeline,
} from "./timeline";

const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const BLOCKED_ID = "00000000-0000-0000-0000-000000000002";
const AUTHOR_ID = "00000000-0000-0000-0000-000000000003";
const REPLY_AUTHOR_ID = "00000000-0000-0000-0000-000000000004";

function makePost(
  override: Record<string, unknown> = {},
): Parameters<typeof shouldIncludePostInTimeline>[0] {
  return {
    accountId: AUTHOR_ID,
    mentions: [],
    sharing: null,
    replyTarget: null,
    ...override,
  } as unknown as Parameters<typeof shouldIncludePostInTimeline>[0];
}

function makeOwner(
  override: Record<string, unknown> = {},
): Parameters<typeof shouldIncludePostInTimeline>[1] {
  return {
    id: OWNER_ID,
    followedTags: [],
    account: {
      id: OWNER_ID,
      following: [],
      blocks: [],
      blockedBy: [],
      mutes: [],
    },
    ...override,
  } as unknown as Parameters<typeof shouldIncludePostInTimeline>[1];
}

function makeFollow(followingId: string, approved: Date | null = new Date()) {
  return {
    iri: `https://hollo.test/@owner#follows/${followingId}`,
    followerId: OWNER_ID,
    followingId,
    shares: true,
    notify: false,
    languages: null,
    approved,
    created: new Date(),
  };
}

describe("timeline block filtering", () => {
  it("excludes posts authored by blocked accounts", () => {
    expect.assertions(1);

    const post = makePost({ accountId: BLOCKED_ID });
    const owner = makeOwner({
      account: {
        id: OWNER_ID,
        following: [],
        blocks: [
          {
            accountId: OWNER_ID,
            blockedAccountId: BLOCKED_ID,
            created: new Date().toISOString(),
          },
        ],
        blockedBy: [],
        mutes: [],
      },
    });

    expect(shouldExcludePostFromTimeline(post, owner)).toBe(true);
  });

  it("excludes shared posts when the original author is blocked", () => {
    expect.assertions(1);

    const post = makePost({
      accountId: AUTHOR_ID,
      sharing: makePost({ accountId: BLOCKED_ID }),
    });
    const owner = makeOwner({
      account: {
        id: OWNER_ID,
        following: [],
        blocks: [
          {
            accountId: OWNER_ID,
            blockedAccountId: BLOCKED_ID,
            created: new Date().toISOString(),
          },
        ],
        blockedBy: [],
        mutes: [],
      },
    });

    expect(shouldExcludePostFromTimeline(post, owner)).toBe(true);
  });

  it("excludes replies to blocked accounts from followed authors", () => {
    expect.assertions(1);

    const post = makePost({
      accountId: AUTHOR_ID,
      replyTarget: makePost({ accountId: BLOCKED_ID }) as Parameters<
        typeof shouldIncludePostInTimeline
      >[0]["replyTarget"],
    });
    const owner = makeOwner({
      account: {
        id: OWNER_ID,
        following: [
          {
            iri: `https://hollo.test/@owner#follows/${AUTHOR_ID}`,
            followerId: OWNER_ID,
            followingId: AUTHOR_ID,
            shares: true,
            notify: false,
            languages: null,
            approved: new Date(),
            created: new Date(),
          },
        ],
        blocks: [
          {
            accountId: OWNER_ID,
            blockedAccountId: BLOCKED_ID,
            created: new Date().toISOString(),
          },
        ],
        blockedBy: [],
        mutes: [],
      },
    });

    expect(shouldIncludePostInTimeline(post, owner)).toBe(false);
  });

  it("excludes private posts from pending follows", () => {
    expect.assertions(1);

    const post = makePost({
      accountId: AUTHOR_ID,
      visibility: "private",
    });
    const owner = makeOwner({
      account: {
        id: OWNER_ID,
        following: [makeFollow(AUTHOR_ID, null)],
        blocks: [],
        blockedBy: [],
        mutes: [],
      },
    });

    expect(shouldIncludePostInTimeline(post, owner)).toBe(false);
  });

  it("excludes replies to pending follows from list timelines with followed replies", () => {
    expect.assertions(1);

    const post = makePost({
      accountId: AUTHOR_ID,
      visibility: "public",
      replyTarget: makePost({
        accountId: REPLY_AUTHOR_ID,
        visibility: "public",
      }) as Parameters<typeof shouldIncludePostInTimeline>[0]["replyTarget"],
    });
    const owner = makeOwner({
      account: {
        id: OWNER_ID,
        following: [makeFollow(REPLY_AUTHOR_ID, null)],
        blocks: [],
        blockedBy: [],
        mutes: [],
      },
    });

    expect(
      shouldIncludePostInList(post, {
        accountOwner: owner,
        members: [{ accountId: AUTHOR_ID }],
        repliesPolicy: "followed",
      } as unknown as Parameters<typeof shouldIncludePostInList>[1]),
    ).toBe(false);
  });
});
