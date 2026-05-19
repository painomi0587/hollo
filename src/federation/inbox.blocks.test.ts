import type { InboxContext } from "@fedify/fedify";
import {
  Announce,
  EmojiReact,
  Follow,
  Like,
  Note,
  Person,
  PUBLIC_COLLECTION,
} from "@fedify/vocab";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import {
  accounts,
  blocks,
  follows,
  instances,
  likes,
  posts,
  reactions,
} from "../schema";
import type { Uuid } from "../uuid";
import {
  onEmojiReactionAdded,
  onFollowed,
  onLiked,
  onPostShared,
} from "./inbox";

function createCtx() {
  return {
    origin: "https://hollo.test",
    parseUri: (uri: URL | null) => {
      if (uri == null) return null;
      // Minimal parseUri for local actor URIs of the form
      // https://hollo.test/@<handle>
      const match = uri.href.match(/^https:\/\/hollo\.test\/@([^/]+)$/);
      if (match != null) {
        return { type: "actor" as const, identifier: match[1] };
      }
      return null;
    },
    sendActivity: vi.fn(async () => undefined),
    getActorUri: (handle: string) => new URL(`https://hollo.test/@${handle}`),
    forwardActivity: vi.fn(async () => undefined),
  } as unknown as InboxContext<void>;
}

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
    where: eq(accounts.id, id),
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

async function seedLocalPost(authorId: Uuid, content: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://hollo.test/posts/${id}`;
  await db.insert(posts).values({
    id,
    iri,
    type: "Note",
    accountId: authorId,
    visibility: "public",
    contentHtml: `<p>${content}</p>`,
    content,
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return { id, iri };
}

describe("inbox block enforcement", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("drops Follow from a blocked actor (even on a protected account)", async () => {
    expect.assertions(1);
    const owner = await createAccount({ username: "hollo" });
    const ownerAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, owner.id as Uuid),
    });
    if (ownerAccount == null) throw new Error("Failed to load local account");
    await db
      .update(accounts)
      .set({ protected: true })
      .where(eq(accounts.id, owner.id as Uuid));
    const followerAccount = await seedRemoteAccount("remote.test", "evil");
    await db.insert(blocks).values({
      accountId: owner.id as Uuid,
      blockedAccountId: followerAccount.id,
    });

    const follow = new Follow({
      id: new URL(`${followerAccount.iri}#follows/${crypto.randomUUID()}`),
      actor: new Person({
        id: new URL(followerAccount.iri),
        preferredUsername: "evil",
        inbox: new URL(`${followerAccount.iri}/inbox`),
      }),
      object: new Person({
        id: new URL(ownerAccount.iri),
        preferredUsername: "hollo",
        inbox: new URL(`${ownerAccount.iri}/inbox`),
      }),
    });

    await onFollowed(createCtx(), follow);

    const recorded = await db.query.follows.findFirst({
      where: and(
        eq(follows.followingId, owner.id as Uuid),
        eq(follows.followerId, followerAccount.id),
      ),
    });
    expect(recorded).toBeUndefined();
  });

  it("drops Like from a blocked actor on a local post", async () => {
    expect.assertions(2);
    const owner = await createAccount({ username: "hollo" });
    const liker = await seedRemoteAccount("remote.test", "evil");
    const post = await seedLocalPost(owner.id as Uuid, "hello");

    const like = new Like({
      id: new URL(`${liker.iri}#likes/${post.id}`),
      actor: new Person({
        id: new URL(liker.iri),
        preferredUsername: "evil",
        inbox: new URL(`${liker.iri}/inbox`),
      }),
      object: new URL(post.iri),
    });

    // Control: same Like without the block must be recorded.
    await onLiked(createCtx(), like);
    const beforeBlock = await db.query.likes.findFirst({
      where: and(eq(likes.postId, post.id), eq(likes.accountId, liker.id)),
    });
    expect(beforeBlock).not.toBeUndefined();

    // Now block and replay with a fresh like target row: assert the
    // block path actually drops the activity.
    await db.delete(likes);
    await db.insert(blocks).values({
      accountId: owner.id as Uuid,
      blockedAccountId: liker.id,
    });
    await onLiked(createCtx(), like);
    const afterBlock = await db.query.likes.findFirst({
      where: and(eq(likes.postId, post.id), eq(likes.accountId, liker.id)),
    });
    expect(afterBlock).toBeUndefined();
  });

  it("drops EmojiReact from a blocked actor on a local post", async () => {
    expect.assertions(2);
    const owner = await createAccount({ username: "hollo" });
    const reactor = await seedRemoteAccount("remote.test", "evil");
    const post = await seedLocalPost(owner.id as Uuid, "hello");

    const react = new EmojiReact({
      id: new URL(`${reactor.iri}#react/${post.id}`),
      actor: new Person({
        id: new URL(reactor.iri),
        preferredUsername: "evil",
        inbox: new URL(`${reactor.iri}/inbox`),
      }),
      object: new URL(post.iri),
      content: "👍",
    });

    await onEmojiReactionAdded(createCtx(), react);
    const beforeBlock = await db.query.reactions.findFirst({
      where: and(
        eq(reactions.postId, post.id),
        eq(reactions.accountId, reactor.id),
      ),
    });
    expect(beforeBlock).not.toBeUndefined();

    await db.delete(reactions);
    await db.insert(blocks).values({
      accountId: owner.id as Uuid,
      blockedAccountId: reactor.id,
    });
    await onEmojiReactionAdded(createCtx(), react);
    const afterBlock = await db.query.reactions.findFirst({
      where: and(
        eq(reactions.postId, post.id),
        eq(reactions.accountId, reactor.id),
      ),
    });
    expect(afterBlock).toBeUndefined();
  });

  it("drops Announce from a blocked actor for a local post", async () => {
    expect.assertions(2);
    const owner = await createAccount({ username: "hollo" });
    const sharer = await seedRemoteAccount("remote.test", "evil");
    const post = await seedLocalPost(owner.id as Uuid, "hello");

    const announce = new Announce({
      id: new URL(`${sharer.iri}/announces/${post.id}`),
      actor: new Person({
        id: new URL(sharer.iri),
        preferredUsername: "evil",
        inbox: new URL(`${sharer.iri}/inbox`),
      }),
      object: new Note({ id: new URL(post.iri) }),
      to: PUBLIC_COLLECTION,
    });

    await onPostShared(createCtx(), announce);
    const beforeBlock = await db.query.posts.findFirst({
      where: and(eq(posts.accountId, sharer.id), eq(posts.sharingId, post.id)),
    });
    expect(beforeBlock).not.toBeUndefined();

    // Reset (drop both the share row and any cached announce-IRI row),
    // install the block, and replay with a different announce IRI so
    // persistSharingPost doesn't short-circuit on the cached row.
    await db.delete(posts).where(eq(posts.accountId, sharer.id));
    await db.insert(blocks).values({
      accountId: owner.id as Uuid,
      blockedAccountId: sharer.id,
    });
    const blockedAnnounce = new Announce({
      id: new URL(`${sharer.iri}/announces/blocked-${post.id}`),
      actor: new Person({
        id: new URL(sharer.iri),
        preferredUsername: "evil",
        inbox: new URL(`${sharer.iri}/inbox`),
      }),
      object: new Note({ id: new URL(post.iri) }),
      to: PUBLIC_COLLECTION,
    });
    await onPostShared(createCtx(), blockedAnnounce);
    const afterBlock = await db.query.posts.findFirst({
      where: and(eq(posts.accountId, sharer.id), eq(posts.sharingId, post.id)),
    });
    expect(afterBlock).toBeUndefined();
  });
});
