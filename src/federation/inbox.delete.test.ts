import type { InboxContext } from "@fedify/fedify";
import { Delete } from "@fedify/vocab";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import { accounts, instances, posts } from "../schema";
import type { Uuid } from "../uuid";
import { onPostDeleted } from "./inbox";

const ctx = {
  origin: "https://hollo.test",
} as InboxContext<void>;

async function seedRemoteAccount(host: string, username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://${host}/@${username}`;
  await db
    .insert(instances)
    .values({ host, software: "mastodon", softwareVersion: null })
    .onConflictDoNothing();
  await db.insert(accounts).values({
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
  });
  const account = await db.query.accounts.findFirst({
    where: { id: { eq: id } },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

async function seedRemotePost(authorId: Uuid, authorIri: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `${authorIri}/posts/${id}`;
  await db.insert(posts).values({
    id,
    iri,
    type: "Note",
    accountId: authorId,
    visibility: "public",
    contentHtml: "<p>Hello</p>",
    content: "Hello",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return { id, iri };
}

describe("onPostDeleted", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deletes the post when the actor shares the author's origin", async () => {
    expect.assertions(1);
    const author = await seedRemoteAccount("remote.test", "author");
    const post = await seedRemotePost(author.id, author.iri);
    const del = new Delete({
      id: new URL(`${author.iri}#delete/${post.id}`),
      actor: new URL(author.iri),
      object: new URL(post.iri),
    });

    await onPostDeleted(ctx, del);

    const remaining = await db.query.posts.findFirst({
      where: { iri: { eq: post.iri } },
    });
    expect(remaining).toBeUndefined();
  });

  it("ignores Delete from an actor on a different origin than the author", async () => {
    expect.assertions(2);
    const author = await seedRemoteAccount("remote.test", "author");
    const evil = await seedRemoteAccount("evil.test", "evil");
    const post = await seedRemotePost(author.id, author.iri);
    const del = new Delete({
      id: new URL(`${evil.iri}#delete/${post.id}`),
      actor: new URL(evil.iri),
      object: new URL(post.iri),
    });

    await onPostDeleted(ctx, del);

    const remaining = await db.query.posts.findFirst({
      where: { iri: { eq: post.iri } },
    });
    expect(remaining).not.toBeUndefined();
    expect(remaining?.iri).toBe(post.iri);
  });

  it("ignores Delete when the actor's origin differs from a local post's author", async () => {
    expect.assertions(1);
    const author = await seedRemoteAccount("hollo.test", "hollo");
    const evil = await seedRemoteAccount("evil.test", "evil");
    const post = await seedRemotePost(author.id, author.iri);
    const del = new Delete({
      id: new URL(`${evil.iri}#delete/${post.id}`),
      actor: new URL(evil.iri),
      object: new URL(post.iri),
    });

    await onPostDeleted(ctx, del);

    const remaining = await db.query.posts.findFirst({
      where: { iri: { eq: post.iri } },
    });
    expect(remaining).not.toBeUndefined();
  });
});
