import {
  Announce,
  type InboxContext,
  Note,
  Person,
  PUBLIC_COLLECTION,
} from "@fedify/fedify";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows, instances, posts, timelinePosts } from "../schema";
import type { Uuid } from "../uuid";
import { onPostShared } from "./inbox";
import { persistSharingPost } from "./post";

async function seedRemoteAccount(username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://remote.test/@${username}`;
  await db
    .insert(instances)
    .values({
      host: "remote.test",
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  await db.insert(accounts).values({
    id,
    iri,
    type: "Person",
    name: username,
    handle: `@${username}@remote.test`,
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${iri}/inbox`,
    followersUrl: `${iri}/followers`,
    sharedInboxUrl: "https://remote.test/inbox",
    featuredUrl: `${iri}/featured`,
    instanceHost: "remote.test",
    published: new Date(),
  });
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, id),
    with: { owner: true },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

function createPerson(account: {
  handle: string;
  iri: string;
  followersUrl: string | null;
}) {
  return new Person({
    id: new URL(account.iri),
    name: account.handle,
    inbox: new URL(`${account.iri}/inbox`),
    followers:
      account.followersUrl == null ? null : new URL(account.followersUrl),
  });
}

function createAnnounce(id: string, actor: Person, object: string | Note) {
  return new Announce({
    id: new URL(id),
    actor,
    object: typeof object === "string" ? new URL(object) : object,
    to: PUBLIC_COLLECTION,
  });
}

function createCtx() {
  const forwardActivity = vi.fn(async () => undefined);
  const ctx = {
    origin: "https://hollo.test",
    parseUri: () => null,
    forwardActivity,
  } as unknown as InboxContext<void>;
  return { ctx, forwardActivity };
}

async function seedShareScenario() {
  const owner = await createAccount({ username: "hollo" });
  const author = await seedRemoteAccount("author");
  const sharer = await seedRemoteAccount("sharer");
  await db.insert(follows).values({
    iri: `https://hollo.test/@hollo#follows/${sharer.id}`,
    followingId: sharer.id,
    followerId: owner.id as Uuid,
    approved: new Date(),
    shares: true,
    notify: false,
  });
  const originalPostId = crypto.randomUUID() as Uuid;
  const originalPostIri = "https://remote.test/@author/posts/1";
  await db.insert(posts).values({
    id: originalPostId,
    iri: originalPostIri,
    type: "Note",
    accountId: author.id,
    visibility: "public",
    contentHtml: "<p>Shared once</p>",
    content: "Shared once",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return {
    actor: createPerson(sharer),
    object: new Note({ id: new URL(originalPostIri) }),
    originalPostId,
    originalPostIri,
    sharer,
  };
}

async function seedLocalPostShareScenario() {
  const author = await createAccount({ username: "hollo" });
  const sharer = await seedRemoteAccount("sharer");
  const originalPostId = crypto.randomUUID() as Uuid;
  const originalPostIri = `https://hollo.test/@hollo/${originalPostId}`;
  await db.insert(posts).values({
    id: originalPostId,
    iri: originalPostIri,
    type: "Note",
    accountId: author.id as Uuid,
    visibility: "public",
    contentHtml: "<p>Local post</p>",
    content: "Local post",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return {
    actor: createPerson(sharer),
    object: new Note({ id: new URL(originalPostIri) }),
    originalPostIri,
  };
}

describe("persistSharingPost", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns an existing share when the same actor announces the same post with another IRI", async () => {
    expect.assertions(5);
    const { actor, object, originalPostId, originalPostIri, sharer } =
      await seedShareScenario();

    const first = await persistSharingPost(
      db,
      createAnnounce(
        "https://remote.test/@sharer/announces/1",
        actor,
        originalPostIri,
      ),
      object,
      "https://hollo.test",
      { account: sharer },
    );
    const second = await persistSharingPost(
      db,
      createAnnounce(
        "https://remote.test/@sharer/announces/2",
        actor,
        originalPostIri,
      ),
      object,
      "https://hollo.test",
      { account: sharer },
    );

    const sharingPosts = await db.query.posts.findMany({
      where: and(
        eq(posts.accountId, sharer.id),
        eq(posts.sharingId, originalPostId),
      ),
    });
    const timelineRows = await db.query.timelinePosts.findMany({
      where: eq(timelinePosts.postId, first!.id),
    });
    const originalPost = await db.query.posts.findFirst({
      where: eq(posts.id, originalPostId),
    });
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(sharingPosts).toHaveLength(1);
    expect(timelineRows).toHaveLength(1);
    expect(originalPost?.sharesCount).toBe(1);
  });

  it("handles concurrent duplicate announces atomically", async () => {
    expect.assertions(5);
    const { actor, object, originalPostId, originalPostIri, sharer } =
      await seedShareScenario();

    const [first, second] = await Promise.all([
      persistSharingPost(
        db,
        createAnnounce(
          "https://remote.test/@sharer/announces/1",
          actor,
          originalPostIri,
        ),
        object,
        "https://hollo.test",
        { account: sharer },
      ),
      persistSharingPost(
        db,
        createAnnounce(
          "https://remote.test/@sharer/announces/2",
          actor,
          originalPostIri,
        ),
        object,
        "https://hollo.test",
        { account: sharer },
      ),
    ]);

    const sharingPosts = await db.query.posts.findMany({
      where: and(
        eq(posts.accountId, sharer.id),
        eq(posts.sharingId, originalPostId),
      ),
    });
    const timelineRows = await db.query.timelinePosts.findMany({
      where: eq(timelinePosts.postId, first!.id),
    });
    const originalPost = await db.query.posts.findFirst({
      where: eq(posts.id, originalPostId),
    });
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(sharingPosts).toHaveLength(1);
    expect(timelineRows).toHaveLength(1);
    expect(originalPost?.sharesCount).toBe(1);
  });

  it("does not forward duplicate announces for a local post", async () => {
    expect.assertions(1);
    const { actor, object } = await seedLocalPostShareScenario();
    const { ctx, forwardActivity } = createCtx();

    await onPostShared(
      ctx,
      createAnnounce("https://remote.test/@sharer/announces/1", actor, object),
    );
    await onPostShared(
      ctx,
      createAnnounce("https://remote.test/@sharer/announces/2", actor, object),
    );

    expect(forwardActivity).toHaveBeenCalledOnce();
  });
});
