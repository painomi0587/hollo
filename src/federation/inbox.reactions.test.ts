import type { InboxContext } from "@fedify/fedify";
import { EmojiReact, Like, Person } from "@fedify/fedify/vocab";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, instances, likes, posts, reactions } from "../schema";
import type { Uuid } from "../uuid";
import { onEmojiReactionAdded, onLiked } from "./inbox";

async function seedRemoteTargetPost(): Promise<{ id: Uuid; iri: string }> {
  await db
    .insert(instances)
    .values({
      host: "remote.test",
      software: "misskey",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  const remoteAccountId = crypto.randomUUID() as Uuid;
  const remoteAccountIri = "https://remote.test/@author";
  await db.insert(accounts).values({
    id: remoteAccountId,
    iri: remoteAccountIri,
    type: "Person",
    name: "Remote author",
    handle: "@author@remote.test",
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${remoteAccountIri}/inbox`,
    followersUrl: `${remoteAccountIri}/followers`,
    sharedInboxUrl: "https://remote.test/inbox",
    featuredUrl: `${remoteAccountIri}/featured`,
    instanceHost: "remote.test",
    published: new Date(),
  });
  const postId = crypto.randomUUID() as Uuid;
  const postIri = "https://remote.test/notes/remote-1";
  await db.insert(posts).values({
    id: postId,
    iri: postIri,
    type: "Note",
    accountId: remoteAccountId,
    visibility: "public",
    tags: {},
    emojis: {},
    sensitive: false,
    updated: new Date(),
  });
  return { id: postId, iri: postIri };
}

async function seedLocalLiker(): Promise<{ iri: string }> {
  const owner = await createAccount({ username: "liker" });
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, owner.id as Uuid),
  });
  if (account == null) {
    throw new Error("Failed to seed local liker");
  }
  return { iri: account.iri };
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

function createLocalPerson(iri: string): Person {
  return new Person({
    id: new URL(iri),
    preferredUsername: "liker",
    name: "Liker",
    inbox: new URL(`${iri}/inbox`),
    followers: new URL(`${iri}/followers`),
  });
}

describe("federation inbox reaction target fallback", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists Like for remote object IRI via fallback and remains idempotent", async () => {
    expect.assertions(3);
    const target = await seedRemoteTargetPost();
    const liker = await seedLocalLiker();
    const person = createLocalPerson(liker.iri);
    const { ctx, forwardActivity } = createCtx();
    const activity = new Like({
      actor: person,
      object: new URL(target.iri),
    });

    await onLiked(ctx, activity as unknown as Like);
    await onLiked(ctx, activity as unknown as Like);

    const foundLikes = await db.query.likes.findMany({
      where: eq(likes.postId, target.id),
    });
    expect(foundLikes).toHaveLength(1);
    expect(foundLikes[0]?.postId).toBe(target.id);
    expect(forwardActivity).not.toHaveBeenCalled();
  });

  it("persists EmojiReact for remote object IRI via fallback and remains idempotent", async () => {
    expect.assertions(3);
    const target = await seedRemoteTargetPost();
    const liker = await seedLocalLiker();
    const person = createLocalPerson(liker.iri);
    const { ctx, forwardActivity } = createCtx();
    const activity = new EmojiReact({
      actor: person,
      object: new URL(target.iri),
      content: "👍",
    });

    await onEmojiReactionAdded(ctx, activity as unknown as EmojiReact);
    await onEmojiReactionAdded(ctx, activity as unknown as EmojiReact);

    const foundReactions = await db.query.reactions.findMany({
      where: eq(reactions.postId, target.id),
    });
    expect(foundReactions).toHaveLength(1);
    expect(foundReactions[0]?.emoji).toBe("👍");
    expect(forwardActivity).not.toHaveBeenCalled();
  });
});
