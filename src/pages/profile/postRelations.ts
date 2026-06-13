// Drizzle relational query `with` clause that hydrates a post with every
// nested relation the Post component needs in order to render: the author's
// account (and its owner row, used to detect local accounts and emit
// permalink-based reaction list links), media, polls, reply targets, quote
// targets, the sharing relation when the post is a boost, and the reactions
// rendered in the post footer.
//
// Reuse this constant for every query whose results are passed to
// PostView so the four SSR queries (profile feed, post permalink, hashtag
// feed, and the reaction list pages) stay in sync when the post relation
// graph changes.
export const postViewRelations = {
  account: { with: { owner: true } },
  media: true,
  poll: { with: { options: true } },
  sharing: {
    with: {
      account: { with: { owner: true } },
      media: true,
      poll: { with: { options: true } },
      replyTarget: { with: { account: { with: { owner: true } } } },
      quoteTarget: {
        with: {
          account: { with: { owner: true } },
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: { with: { owner: true } } } },
          reactions: true,
        },
      },
      reactions: true,
    },
  },
  replyTarget: { with: { account: { with: { owner: true } } } },
  quoteTarget: {
    with: {
      account: { with: { owner: true } },
      media: true,
      poll: { with: { options: true } },
      replyTarget: { with: { account: { with: { owner: true } } } },
      reactions: true,
    },
  },
  reactions: true,
} as const;
