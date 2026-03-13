import { describe, expect, it } from "vitest";
import {
  shouldExcludePostFromTimeline,
  shouldIncludePostInTimeline,
} from "./timeline";

const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const BLOCKED_ID = "00000000-0000-0000-0000-000000000002";
const AUTHOR_ID = "00000000-0000-0000-0000-000000000003";

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
});
