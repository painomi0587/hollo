import { Emoji, Flag, Note, QuoteAuthorization } from "@fedify/vocab";

import { db } from "../db";
import { accounts } from "../schema";
import { isUuid, type Uuid } from "../uuid";
import { toEmoji } from "./emoji";
import { federation } from "./federation";
import { toObject } from "./post";

export async function hasApprovedFollowFromKeyOwner(
  keyOwnerId: URL,
  followingId: Uuid,
): Promise<boolean> {
  const found = await db.query.follows.findFirst({
    where: {
      RAW: (follows, { and, eq, inArray, isNotNull }) =>
        and(
          inArray(
            follows.followerId,
            db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, keyOwnerId.href)),
          ),
          eq(follows.followingId, followingId),
          isNotNull(follows.approved),
        )!,
    },
  });
  return found != null;
}

federation.setObjectDispatcher(
  Note,
  "/@{username}/{id}",
  async (ctx, values) => {
    if (!values.id?.match(/^[-a-f0-9]+$/)) return null;
    const owner = await db.query.accountOwners.findFirst({
      where: { handle: { like: values.username } },
      with: { account: true },
    });
    if (owner == null) return null;
    if (!isUuid(values.id)) return null;
    const post = await db.query.posts.findFirst({
      where: {
        id: { eq: values.id },
        accountId: { eq: owner.account.id },
      },
      with: {
        account: { with: { owner: true } },
        replyTarget: true,
        quoteTarget: true,
        media: true,
        poll: { with: { options: { orderBy: { index: "asc" } } } },
        mentions: { with: { account: true } },
        replies: { limit: 20 },
      },
    });
    if (post == null) return null;
    if (post.visibility === "private") {
      const keyOwner = await ctx.getSignedKeyOwner();
      if (keyOwner?.id == null) return null;
      if (!(await hasApprovedFollowFromKeyOwner(keyOwner.id, owner.id))) {
        return null;
      }
    } else if (post.visibility === "direct") {
      const keyOwner = await ctx.getSignedKeyOwner();
      const keyOwnerId = keyOwner?.id;
      if (keyOwnerId == null) return null;
      const found = post.mentions.some(
        (m) => m.account.iri === keyOwnerId.href,
      );
      if (!found) return null;
    }
    return toObject(post, ctx);
  },
);

federation.setObjectDispatcher(
  Emoji,
  "/emojis/:{shortcode}:",
  async (ctx, { shortcode }) => {
    const emoji = await db.query.customEmojis.findFirst({
      where: { shortcode: { eq: shortcode } },
    });
    if (emoji == null) return null;
    return toEmoji(ctx, emoji);
  },
);

federation.setObjectDispatcher(
  QuoteAuthorization,
  "/@{username}/{id}/quote_authorizations/{quoteId}",
  async (ctx, values) => {
    if (!values.id?.match(/^[-a-f0-9]+$/)) return null;
    if (!values.quoteId?.match(/^[-a-f0-9]+$/)) return null;
    const owner = await db.query.accountOwners.findFirst({
      where: { handle: { like: values.username } },
      with: { account: true },
    });
    if (owner == null) return null;
    if (!isUuid(values.id) || !isUuid(values.quoteId)) return null;
    const targetPost = await db.query.posts.findFirst({
      where: {
        id: { eq: values.id },
        accountId: { eq: owner.account.id },
      },
      with: {
        account: { with: { owner: true } },
        mentions: { with: { account: true } },
      },
    });
    if (targetPost == null) return null;
    if (targetPost.visibility === "private") {
      const keyOwner = await ctx.getSignedKeyOwner();
      if (keyOwner?.id == null) return null;
      if (!(await hasApprovedFollowFromKeyOwner(keyOwner.id, owner.id))) {
        return null;
      }
    } else if (targetPost.visibility === "direct") {
      const keyOwner = await ctx.getSignedKeyOwner();
      const keyOwnerId = keyOwner?.id;
      if (keyOwnerId == null) return null;
      const found = targetPost.mentions.some(
        (m) => m.account.iri === keyOwnerId.href,
      );
      if (!found) return null;
    }
    const quotePost = await db.query.posts.findFirst({
      where: {
        id: { eq: values.quoteId },
        quoteTargetId: { eq: targetPost.id },
        OR: [
          { quoteState: { eq: "accepted" } },
          { quoteState: { isNull: true } },
        ],
      },
    });
    if (quotePost == null) return null;
    return new QuoteAuthorization({
      id: new URL(`${targetPost.iri}/quote_authorizations/${quotePost.id}`),
      attribution: new URL(targetPost.account.iri),
      interactingObject: new URL(quotePost.iri),
      interactionTarget: new URL(targetPost.iri),
    });
  },
);

federation.setObjectDispatcher(Flag, "/reports/{id}", async (ctx, { id }) => {
  if (!isUuid(id)) return null;
  const report = await db.query.reports.findFirst({
    where: { id: { eq: id } },
    with: {
      account: {
        columns: { iri: true },
      },
      targetAccount: {
        columns: {
          iri: true,
        },
      },
    },
  });

  if (report == null) return null;

  // Perform some access control on fetching a Flag activity
  const keyOwner = await ctx.getSignedKeyOwner();
  const keyOwnerId = keyOwner?.id;
  if (keyOwnerId == null) return null;

  // compare the keyOwner who signed the request with the targetAccount
  // Note: this won't work if it's the instance actor doing the fetch and not the targetAccount:
  if (keyOwnerId.href !== report.targetAccount.iri) {
    return null;
  }

  // Fetch the posts for the Flag activity:
  let targetPosts: { iri: string }[] = [];
  if (report.posts.length > 0) {
    targetPosts = await db.query.posts.findMany({
      where: {
        RAW: (posts, { and, eq, inArray }) =>
          and(
            inArray(posts.id, report.posts),
            eq(posts.accountId, report.targetAccountId),
          )!,
      },
      columns: {
        iri: true,
      },
    });
  }

  return new Flag({
    id: new URL(report.iri),
    actor: new URL(report.account.iri),
    // For Mastodon compatibility, objects must include the target account IRI along with the posts:
    objects: targetPosts
      .map((post) => new URL(post.iri))
      .concat(new URL(report.targetAccount.iri)),
    content: report.comment,
  });
});
