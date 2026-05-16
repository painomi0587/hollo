import { Hono } from "hono";

import { Layout } from "../../components/Layout.tsx";
import { Post as PostView } from "../../components/Post.tsx";
import db from "../../db.ts";
import {
  type Account,
  type AccountOwner,
  type Medium,
  type Poll,
  type PollOption,
  type Post,
  type Reaction,
} from "../../schema.ts";
import { isUuid } from "../../uuid.ts";

const profilePost = new Hono();

profilePost.get<"/:handle{@[^/]+}/:id{[-a-f0-9]+}">(async (c) => {
  let handle = c.req.param("handle");
  const postId = c.req.param("id");
  if (!isUuid(postId)) return c.notFound();
  if (handle.startsWith("@")) handle = handle.substring(1);
  const accountOwner = await db.query.accountOwners.findFirst({
    where: { handle: { eq: handle } },
  });
  if (accountOwner == null) return c.notFound();
  const post = await db.query.posts.findFirst({
    where: {
      RAW: (posts, { and, eq, or }) =>
        and(
          eq(posts.accountId, accountOwner.id),
          eq(posts.id, postId),
          or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        )!,
    },
    with: {
      account: true,
      media: true,
      poll: { with: { options: true } },
      sharing: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          quoteTarget: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              reactions: true,
            },
          },
          reactions: true,
        },
      },
      replyTarget: { with: { account: true } },
      quoteTarget: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          reactions: true,
        },
      },
      replies: {
        where: { visibility: { in: ["public", "unlisted"] } },
        orderBy: (posts, { desc }) => [desc(posts.published)],
        limit: 20,
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          sharing: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              quoteTarget: {
                with: {
                  account: true,
                  media: true,
                  poll: { with: { options: true } },
                  replyTarget: { with: { account: true } },
                  reactions: true,
                },
              },
              reactions: true,
            },
          },
          replyTarget: { with: { account: true } },
          quoteTarget: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              reactions: true,
            },
          },
          reactions: true,
        },
      },
      reactions: true,
    },
  });
  if (post == null) return c.notFound();
  return c.html(
    <PostPage post={post} accountOwner={accountOwner} baseUrl={c.req.url} />,
  );
});

interface PostPageProps {
  readonly accountOwner: AccountOwner;
  readonly post: Post & {
    account: Account;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    sharing:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
          quoteTarget:
            | (Post & {
                account: Account;
                media: Medium[];
                poll: (Poll & { options: PollOption[] }) | null;
                replyTarget: (Post & { account: Account }) | null;
                reactions: Reaction[];
              })
            | null;
          reactions: Reaction[];
        })
      | null;
    replyTarget: (Post & { account: Account }) | null;
    quoteTarget:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
          reactions: Reaction[];
        })
      | null;
    replies: (Post & {
      account: Account;
      media: Medium[];
      poll: (Poll & { options: PollOption[] }) | null;
      sharing:
        | (Post & {
            account: Account;
            media: Medium[];
            poll: (Poll & { options: PollOption[] }) | null;
            replyTarget: (Post & { account: Account }) | null;
            quoteTarget:
              | (Post & {
                  account: Account;
                  media: Medium[];
                  poll: (Poll & { options: PollOption[] }) | null;
                  replyTarget: (Post & { account: Account }) | null;
                  reactions: Reaction[];
                })
              | null;
            reactions: Reaction[];
          })
        | null;
      replyTarget: (Post & { account: Account }) | null;
      quoteTarget:
        | (Post & {
            account: Account;
            media: Medium[];
            poll: (Poll & { options: PollOption[] }) | null;
            replyTarget: (Post & { account: Account }) | null;
            reactions: Reaction[];
          })
        | null;
      reactions: Reaction[];
    })[];
    reactions: Reaction[];
  };
  readonly baseUrl: URL | string;
}

function PostPage({ post, accountOwner, baseUrl }: PostPageProps) {
  const summary =
    post.summary ??
    ((post.content ?? "").length > 30
      ? `${(post.content ?? "").substring(0, 30)}…`
      : (post.content ?? ""));
  return (
    <Layout
      title={`${summary} — ${post.account.name}`}
      shortTitle={summary}
      description={post.summary ?? post.content}
      imageUrl={post.account.avatarUrl}
      url={post.url ?? post.iri}
      links={[
        { rel: "alternate", type: "application/activity+json", href: post.iri },
      ]}
      themeColor={accountOwner.themeColor}
    >
      <main class="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
        <PostView post={post} featured={true} baseUrl={baseUrl} />
        {post.replies.length > 0 && (
          <section class="mt-8">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {post.replies.length === 1
                ? "1 reply"
                : `${post.replies.length} replies`}
            </h2>
            <div class="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
              {post.replies.map((reply) => (
                <PostView post={reply} baseUrl={baseUrl} />
              ))}
            </div>
          </section>
        )}
      </main>
    </Layout>
  );
}

export default profilePost;
