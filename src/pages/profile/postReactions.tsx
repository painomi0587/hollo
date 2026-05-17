import { and, count, eq, isNull, or } from "drizzle-orm";
import { type Context, Hono } from "hono";

import { Layout } from "../../components/Layout.tsx";
import { type PostForView, Post as PostView } from "../../components/Post.tsx";
import { PublicAccountList } from "../../components/PublicAccountList.tsx";
import db from "../../db.ts";
import { proxyUrl } from "../../media-proxy.ts";
import { type AccountOwner, likes, posts, reactions } from "../../schema.ts";
import { isUuid } from "../../uuid.ts";
import { postViewRelations } from "./postRelations.ts";
import { summarizePostForTitle } from "./summary.ts";

const PAGE_SIZE = 100;

const postReactions = new Hono();

async function loadLocalPost(c: Context): Promise<{
  accountOwner: AccountOwner;
  post: PostForView;
} | null> {
  let handle = c.req.param("handle");
  const postId = c.req.param("id");
  if (handle == null || postId == null) return null;
  if (!isUuid(postId)) return null;
  if (handle.startsWith("@")) handle = handle.substring(1);
  const accountOwner = await db.query.accountOwners.findFirst({
    where: { handle: { eq: handle } },
  });
  if (accountOwner == null) return null;
  const post = await db.query.posts.findFirst({
    where: {
      RAW: (posts, { and, eq, or }) =>
        and(
          eq(posts.accountId, accountOwner.id),
          eq(posts.id, postId),
          or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        )!,
    },
    with: postViewRelations,
  });
  if (post == null) return null;
  return { accountOwner, post };
}

function parsePage(c: Context): number | null {
  const pageStr = c.req.query("page");
  if (pageStr === undefined) return 1;
  const parsed = Number.parseInt(pageStr, 10);
  if (Number.isNaN(parsed) || parsed < 1) return null;
  return parsed;
}

function paginationUrls(
  page: number,
  hasNext: boolean,
): { newerUrl?: string; olderUrl?: string } {
  return {
    newerUrl: page > 1 ? `?page=${page - 1}` : undefined,
    olderUrl: hasNext ? `?page=${page + 1}` : undefined,
  };
}

const numberFormatter = new Intl.NumberFormat("en-US");

postReactions.get("/likes", async (c) => {
  const loaded = await loadLocalPost(c);
  if (loaded == null) return c.notFound();
  const { accountOwner, post } = loaded;
  const page = parsePage(c);
  if (page == null) return c.notFound();

  const [{ total }] = await db
    .select({ total: count() })
    .from(likes)
    .where(eq(likes.postId, post.id));
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > maxPage) return c.notFound();

  const rows = await db.query.likes.findMany({
    where: { postId: { eq: post.id } },
    orderBy: (likes, { desc }) => [desc(likes.created)],
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    with: { account: true },
  });

  const { newerUrl, olderUrl } = paginationUrls(page, page * PAGE_SIZE < total);

  return c.html(
    <ReactionListPage
      accountOwner={accountOwner}
      post={post}
      pageTitle="Liked by"
      heading={
        total === 1 ? "1 like" : `${numberFormatter.format(total)} likes`
      }
      baseUrl={c.req.url}
      newerUrl={newerUrl}
      olderUrl={olderUrl}
    >
      <PublicAccountList
        accounts={rows.map((r) => r.account)}
        baseUrl={c.req.url}
      />
    </ReactionListPage>,
  );
});

postReactions.get("/shares", async (c) => {
  const loaded = await loadLocalPost(c);
  if (loaded == null) return c.notFound();
  const { accountOwner, post } = loaded;
  const page = parsePage(c);
  if (page == null) return c.notFound();

  const [{ total }] = await db
    .select({ total: count() })
    .from(posts)
    .where(
      and(
        eq(posts.sharingId, post.id),
        or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      ),
    );
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > maxPage) return c.notFound();

  const rows = await db.query.posts.findMany({
    where: {
      RAW: (posts, { and, eq, or }) =>
        and(
          eq(posts.sharingId, post.id),
          or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        )!,
    },
    orderBy: (posts, { desc }) => [desc(posts.id)],
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    with: { account: true },
  });

  const { newerUrl, olderUrl } = paginationUrls(page, page * PAGE_SIZE < total);

  return c.html(
    <ReactionListPage
      accountOwner={accountOwner}
      post={post}
      pageTitle="Shared by"
      heading={
        total === 1 ? "1 share" : `${numberFormatter.format(total)} shares`
      }
      baseUrl={c.req.url}
      newerUrl={newerUrl}
      olderUrl={olderUrl}
    >
      <PublicAccountList
        accounts={rows.map((r) => r.account)}
        baseUrl={c.req.url}
      />
    </ReactionListPage>,
  );
});

postReactions.get("/reactions/:emoji", async (c) => {
  const emoji = c.req.param("emoji");
  if (emoji == null || emoji === "") return c.notFound();
  const loaded = await loadLocalPost(c);
  if (loaded == null) return c.notFound();
  const { accountOwner, post } = loaded;
  const page = parsePage(c);
  if (page == null) return c.notFound();

  const [{ total }] = await db
    .select({ total: count() })
    .from(reactions)
    .where(and(eq(reactions.postId, post.id), eq(reactions.emoji, emoji)));
  if (total < 1) return c.notFound();
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > maxPage) return c.notFound();

  const rows = await db.query.reactions.findMany({
    where: { postId: { eq: post.id }, emoji: { eq: emoji } },
    orderBy: (reactions, { desc }) => [desc(reactions.created)],
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    with: { account: true },
  });

  const { newerUrl, olderUrl } = paginationUrls(page, page * PAGE_SIZE < total);
  const customEmojiUrl = post.reactions.find(
    (r) => r.emoji === emoji && r.customEmoji != null,
  )?.customEmoji;
  const proxiedEmojiUrl =
    customEmojiUrl == null ? null : proxyUrl(customEmojiUrl, c.req.url);
  const emojiNode =
    proxiedEmojiUrl == null ? (
      <span>{emoji}</span>
    ) : (
      <img
        src={proxiedEmojiUrl}
        alt={emoji}
        title={emoji}
        class="inline h-4 align-text-bottom"
      />
    );
  const headingPrefix =
    total === 1
      ? "1 reaction with "
      : `${numberFormatter.format(total)} reactions with `;

  return c.html(
    <ReactionListPage
      accountOwner={accountOwner}
      post={post}
      pageTitle={`Reacted ${emoji} by`}
      heading={
        <>
          {headingPrefix}
          {emojiNode}
        </>
      }
      baseUrl={c.req.url}
      newerUrl={newerUrl}
      olderUrl={olderUrl}
    >
      <PublicAccountList
        accounts={rows.map((r) => r.account)}
        baseUrl={c.req.url}
      />
    </ReactionListPage>,
  );
});

postReactions.get("/quotes", async (c) => {
  const loaded = await loadLocalPost(c);
  if (loaded == null) return c.notFound();
  const { accountOwner, post } = loaded;
  const page = parsePage(c);
  if (page == null) return c.notFound();

  const [{ total }] = await db
    .select({ total: count() })
    .from(posts)
    .where(
      and(
        eq(posts.quoteTargetId, post.id),
        or(eq(posts.quoteState, "accepted"), isNull(posts.quoteState)),
        isNull(posts.sharingId),
        or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      ),
    );
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > maxPage) return c.notFound();

  const quoteRows = await db.query.posts.findMany({
    where: {
      RAW: (posts, { and, eq, isNull, or }) =>
        and(
          eq(posts.quoteTargetId, post.id),
          or(eq(posts.quoteState, "accepted"), isNull(posts.quoteState)),
          isNull(posts.sharingId),
          or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        )!,
    },
    orderBy: (posts, { desc }) => [desc(posts.id)],
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    with: postViewRelations,
  });

  const { newerUrl, olderUrl } = paginationUrls(page, page * PAGE_SIZE < total);

  return c.html(
    <ReactionListPage
      accountOwner={accountOwner}
      post={post}
      pageTitle="Quoted by"
      heading={
        total === 1 ? "1 quote" : `${numberFormatter.format(total)} quotes`
      }
      baseUrl={c.req.url}
      newerUrl={newerUrl}
      olderUrl={olderUrl}
    >
      <div class="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
        {quoteRows.map((q) => (
          <PostView post={q} baseUrl={c.req.url} />
        ))}
      </div>
    </ReactionListPage>,
  );
});

interface ReactionListPageProps {
  readonly accountOwner: AccountOwner;
  readonly post: PostForView;
  readonly pageTitle: string;
  readonly heading: unknown;
  readonly baseUrl: URL | string;
  readonly newerUrl?: string;
  readonly olderUrl?: string;
  readonly children?: unknown;
}

function ReactionListPage({
  accountOwner,
  post,
  pageTitle,
  heading,
  baseUrl,
  newerUrl,
  olderUrl,
  children,
}: ReactionListPageProps) {
  const summary = summarizePostForTitle(post);
  return (
    <Layout
      title={`${pageTitle}: ${summary} — ${post.account.name}`}
      shortTitle={pageTitle}
      description={post.summary || post.content}
      imageUrl={post.account.avatarUrl}
      themeColor={accountOwner.themeColor}
    >
      <main class="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
        <PostView post={post} featured={true} baseUrl={baseUrl} />
        <section class="mt-8">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {heading}
          </h2>
          {children}
        </section>
        {(newerUrl || olderUrl) && (
          <nav class="mt-8 flex items-center justify-between gap-4">
            <div>
              {newerUrl && (
                <a
                  href={newerUrl}
                  class="inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-brand-700 dark:text-neutral-400 dark:hover:text-brand-400"
                >
                  <span class="i-lucide-arrow-left" aria-hidden="true" />
                  Newer
                </a>
              )}
            </div>
            <div>
              {olderUrl && (
                <a
                  href={olderUrl}
                  class="inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-brand-700 dark:text-neutral-400 dark:hover:text-brand-400"
                >
                  Older
                  <span class="i-lucide-arrow-right" aria-hidden="true" />
                </a>
              )}
            </div>
          </nav>
        )}
      </main>
    </Layout>
  );
}

export default postReactions;
