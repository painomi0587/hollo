import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import { accounts, instances, posts, remoteReplyScrapeJobs } from "../schema";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import {
  countActiveRemoteReplyScrapeJobs,
  enqueueRemoteReplyScrape,
} from "./replies";

async function seedRemotePost() {
  const accountId = crypto.randomUUID() as Uuid;
  await db.insert(instances).values({
    host: "remote.test",
    software: "mastodon",
    softwareVersion: null,
  });
  await db.insert(accounts).values({
    id: accountId,
    iri: "https://remote.test/@author",
    type: "Person",
    name: "author",
    handle: "@author@remote.test",
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: "https://remote.test/@author/inbox",
    followersUrl: "https://remote.test/@author/followers",
    sharedInboxUrl: "https://remote.test/inbox",
    featuredUrl: "https://remote.test/@author/featured",
    instanceHost: "remote.test",
    published: new Date(),
  });

  const postId = uuidv7();
  await db.insert(posts).values({
    id: postId,
    iri: "https://remote.test/@author/posts/1",
    type: "Note",
    accountId,
    visibility: "public",
    contentHtml: "<p>Hello</p>",
    content: "Hello",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });

  const post = await db.query.posts.findFirst({
    where: eq(posts.id, postId),
  });
  if (post == null) throw new Error("Failed to seed post");
  return post;
}

describe("enqueueRemoteReplyScrape", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deduplicates concurrent jobs for the same replies collection", async () => {
    expect.assertions(1);
    const post = await seedRemotePost();
    const repliesIri = new URL("https://remote.test/@author/posts/1/replies");

    await Promise.all(
      Array.from({ length: 20 }, () =>
        enqueueRemoteReplyScrape(db, {
          baseUrl: "https://hollo.test",
          post,
          repliesIri,
        }),
      ),
    );

    const jobs = await db
      .select()
      .from(remoteReplyScrapeJobs)
      .where(eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href));
    expect(jobs).toHaveLength(1);
  });

  it("counts active jobs for a replies collection", async () => {
    expect.assertions(1);
    const post = await seedRemotePost();
    const repliesIri = new URL("https://remote.test/@author/posts/1/replies");
    const otherRepliesIri = new URL(
      "https://remote.test/@author/posts/2/replies",
    );

    await db.insert(remoteReplyScrapeJobs).values([
      {
        id: uuidv7(),
        postId: post.id,
        postIri: post.iri,
        repliesIri: repliesIri.href,
        baseUrl: "https://hollo.test",
        originHost: repliesIri.host,
        status: "processing",
      },
      {
        id: uuidv7(),
        postId: post.id,
        postIri: post.iri,
        repliesIri: otherRepliesIri.href,
        baseUrl: "https://hollo.test",
        originHost: otherRepliesIri.host,
        status: "completed",
      },
      {
        id: uuidv7(),
        postId: post.id,
        postIri: post.iri,
        repliesIri: "https://remote.test/@author/posts/3/replies",
        baseUrl: "https://hollo.test",
        originHost: "remote.test",
        status: "pending",
      },
    ]);

    await expect(
      countActiveRemoteReplyScrapeJobs(db, repliesIri),
    ).resolves.toBe(1);
  });
});
