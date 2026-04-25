import type { RemoteDocument } from "@fedify/vocab";
import { eq, isNotNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import {
  accounts,
  instances,
  posts,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import {
  claimRemoteReplyScrapeJob,
  processDueRemoteReplyScrapeJobs,
} from "./replies-worker";

const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

async function seedRemoteAccount(username: string, host = "remote.test") {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://${host}/@${username}`;
  await db
    .insert(instances)
    .values({
      host,
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  await db
    .insert(accounts)
    .values({
      id,
      iri,
      type: "Person",
      name: username,
      handle: `@${username}@${host}`,
      bioHtml: "",
      emojis: {},
      fieldHtmls: {},
      aliases: [],
      protected: false,
      inboxUrl: `${iri}/inbox`,
      followersUrl: `${iri}/followers`,
      sharedInboxUrl: `https://${host}/inbox`,
      featuredUrl: `${iri}/featured`,
      instanceHost: host,
      published: new Date(),
    })
    .onConflictDoNothing();
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.iri, iri),
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

async function seedPostWithScrapeJob({
  host = "remote.test",
  postIri = `https://${host}/@author/posts/root`,
  repliesIri = `https://${host}/@author/posts/root/replies`,
}: {
  host?: string;
  postIri?: string;
  repliesIri?: string;
} = {}) {
  const author = await seedRemoteAccount("author", host);
  const postId = uuidv7();
  await db.insert(posts).values({
    id: postId,
    iri: postIri,
    type: "Note",
    accountId: author.id,
    visibility: "public",
    contentHtml: "<p>Root</p>",
    content: "Root",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  await db
    .insert(remoteReplyScrapeOrigins)
    .values({
      originHost: new URL(repliesIri).host,
      nextRequestAt: new Date(0),
    })
    .onConflictDoNothing();
  const jobId = uuidv7();
  await db.insert(remoteReplyScrapeJobs).values({
    id: jobId,
    postId,
    postIri,
    repliesIri,
    baseUrl: "https://hollo.test",
    originHost: new URL(repliesIri).host,
    nextAttemptAt: new Date(0),
  });
  return { jobId, postId, postIri, repliesIri };
}

function makeLoader(
  documents: Record<string, unknown>,
  onLoad?: (url: string) => void,
) {
  return async (url: string): Promise<RemoteDocument> => {
    onLoad?.(url);
    const document = documents[url];
    if (document == null) throw new Error(`Unexpected fetch: ${url}`);
    return {
      contextUrl: null,
      document,
      documentUrl: url,
    };
  };
}

function actor(username: string, host = "remote.test") {
  const iri = `https://${host}/@${username}`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: iri,
    type: "Person",
    name: username,
    inbox: `${iri}/inbox`,
    followers: `${iri}/followers`,
  };
}

function reply({
  content = "Reply",
  id,
  replyTarget,
  replies,
  username = "replyer",
}: {
  content?: string;
  id: string;
  replyTarget: string;
  replies?: string;
  username?: string;
}) {
  return {
    id,
    type: "Note",
    attributedTo: `https://remote.test/@${username}`,
    content: `<p>${content}</p>`,
    inReplyTo: replyTarget,
    to: PUBLIC_COLLECTION,
    replies,
  };
}

function collection(id: string, orderedItems: unknown[]) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "OrderedCollection",
    totalItems: orderedItems.length,
    orderedItems,
  };
}

describe("remote replies scrape worker", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("limits how many reply items a single job persists", async () => {
    expect.assertions(4);
    const { postId, postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");

    const firstReply = "https://remote.test/@replyer/posts/1";
    const secondReply = "https://remote.test/@replyer/posts/2";
    const processed = await processDueRemoteReplyScrapeJobs({
      documentLoader: makeLoader({
        [repliesIri]: collection(repliesIri, [
          reply({ id: firstReply, replyTarget: postIri }),
          reply({ id: secondReply, replyTarget: postIri }),
        ]),
        "https://remote.test/@replyer": actor("replyer"),
      }),
      maxItems: 1,
      sleep: async () => undefined,
    });

    const replyPosts = await db.query.posts.findMany({
      where: isNotNull(posts.replyTargetId),
      orderBy: posts.iri,
    });
    const job = await db.query.remoteReplyScrapeJobs.findFirst();
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
    });
    expect(processed).toBe(1);
    expect(replyPosts.map((post) => post.iri)).toEqual([firstReply]);
    expect(job?.fetchedItems).toBe(1);
    expect(post?.repliesCount).toBe(1);
  });

  it("scrapes replies to replies up to the configured depth", async () => {
    expect.assertions(3);
    const { postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");

    const directReply = "https://remote.test/@replyer/posts/1";
    const directReplyReplies = "https://remote.test/@replyer/posts/1/replies";
    const nestedReply = "https://remote.test/@replyer/posts/1-1";
    const nestedReplyReplies = "https://remote.test/@replyer/posts/1-1/replies";
    const documentLoader = makeLoader({
      [repliesIri]: collection(repliesIri, [
        reply({
          id: directReply,
          replyTarget: postIri,
          replies: directReplyReplies,
        }),
      ]),
      [directReplyReplies]: collection(directReplyReplies, [
        reply({
          id: nestedReply,
          replyTarget: directReply,
          replies: nestedReplyReplies,
        }),
      ]),
      "https://remote.test/@replyer": actor("replyer"),
    });

    await processDueRemoteReplyScrapeJobs({
      documentLoader,
      intervalSeconds: 0,
      maxDepth: 2,
      sleep: async () => undefined,
    });
    await processDueRemoteReplyScrapeJobs({
      documentLoader,
      intervalSeconds: 0,
      maxDepth: 2,
      sleep: async () => undefined,
    });

    const replyPosts = await db.query.posts.findMany({
      where: isNotNull(posts.replyTargetId),
      orderBy: posts.iri,
    });
    const jobs = await db.query.remoteReplyScrapeJobs.findMany({
      orderBy: remoteReplyScrapeJobs.depth,
    });
    expect(replyPosts.map((post) => post.iri)).toEqual([
      directReply,
      nestedReply,
    ]);
    expect(jobs.map((job) => job.repliesIri)).toEqual([
      repliesIri,
      directReplyReplies,
    ]);
    expect(jobs.map((job) => job.status)).toEqual(["completed", "completed"]);
  });

  it("does not claim another job for an origin that is already processing", async () => {
    expect.assertions(2);
    const first = await seedPostWithScrapeJob();
    await seedPostWithScrapeJob({
      postIri: "https://remote.test/@author/posts/second",
      repliesIri: "https://remote.test/@author/posts/second/replies",
    });

    const claimed = await claimRemoteReplyScrapeJob("test-worker");
    const skipped = await claimRemoteReplyScrapeJob("test-worker");

    expect(claimed?.id).toBe(first.jobId);
    expect(skipped).toBeNull();
  });

  it("reclaims stale processing jobs and origin locks", async () => {
    expect.assertions(4);
    const first = await seedPostWithScrapeJob();
    await seedPostWithScrapeJob({
      postIri: "https://remote.test/@author/posts/second",
      repliesIri: "https://remote.test/@author/posts/second/replies",
    });
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const reclaimedAt = new Date("2026-04-25T00:01:01.000Z");

    const claimed = await claimRemoteReplyScrapeJob("test-worker", startedAt);
    const reclaimed = await claimRemoteReplyScrapeJob(
      "test-worker",
      reclaimedAt,
      60,
    );

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: eq(remoteReplyScrapeJobs.id, first.jobId),
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(claimed?.id).toBe(first.jobId);
    expect(reclaimed?.id).toBe(first.jobId);
    expect(job?.attempts).toBe(2);
    expect(origin?.processingJobId).toBe(first.jobId);
  });

  it("skips unavailable origins without starving later claimable jobs", async () => {
    expect.assertions(1);
    const now = new Date("2026-04-25T00:00:00.000Z");
    const future = new Date("2026-04-25T01:00:00.000Z");

    for (let i = 0; i < 10; i++) {
      const host = `blocked-${i}.test`;
      await seedPostWithScrapeJob({
        host,
        postIri: `https://${host}/@author/posts/root`,
        repliesIri: `https://${host}/@author/posts/root/replies`,
      });
      await db
        .update(remoteReplyScrapeOrigins)
        .set({ nextRequestAt: future })
        .where(eq(remoteReplyScrapeOrigins.originHost, host));
    }

    const available = await seedPostWithScrapeJob({
      host: "available.test",
      postIri: "https://available.test/@author/posts/root",
      repliesIri: "https://available.test/@author/posts/root/replies",
    });

    const claimed = await claimRemoteReplyScrapeJob("test-worker", now);

    expect(claimed?.id).toBe(available.jobId);
  });

  it("backs off jobs and origins when a replies collection returns HTTP 429", async () => {
    expect.assertions(4);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const error = new Error("rate limited") as Error & {
      response: Response;
    };
    error.response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    });

    const processed = await processDueRemoteReplyScrapeJobs({
      documentLoader: async (url) => {
        if (url === repliesIri) throw error;
        throw new Error(`Unexpected fetch: ${url}`);
      },
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: eq(remoteReplyScrapeJobs.id, jobId),
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(processed).toBe(0);
    expect(job?.status).toBe("pending");
    expect(job?.nextAttemptAt.getTime()).toBe(now.getTime() + 120_000);
    expect(origin?.nextRequestAt.getTime()).toBe(now.getTime() + 120_000);
  });

  it("records per-request timestamps for throttled origin request fields", async () => {
    expect.assertions(3);
    const { postIri, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const requestTimes = [
      new Date("2026-04-25T00:00:01.000Z"),
      new Date("2026-04-25T00:00:02.000Z"),
    ];
    await seedRemoteAccount("replyer");

    await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:00:03.000Z"),
      documentLoader: makeLoader({
        [repliesIri]: collection(repliesIri, [
          reply({
            id: "https://remote.test/@replyer/posts/1",
            replyTarget: postIri,
          }),
        ]),
        "https://remote.test/@replyer": actor("replyer"),
      }),
      intervalSeconds: 10,
      now,
      sleep: async () => undefined,
    });

    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(origin?.lastRequestAt?.toISOString()).toBe(
      "2026-04-25T00:00:02.000Z",
    );
    expect(origin?.nextRequestAt.toISOString()).toBe(
      "2026-04-25T00:00:12.000Z",
    );
    expect(origin?.updated.toISOString()).toBe("2026-04-25T00:00:02.000Z");
  });
});
