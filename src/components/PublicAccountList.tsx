import { escape } from "es-toolkit";

import { renderCustomEmojis } from "../custom-emoji";
import { proxyUrl } from "../media-proxy";
import type { Account } from "../schema";
import { sanitizeHtml } from "../xss";

export interface PublicAccountListProps {
  readonly accounts: readonly Account[];
  readonly baseUrl: URL | string;
}

export function PublicAccountList({
  accounts,
  baseUrl,
}: PublicAccountListProps) {
  return (
    <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
      {accounts.map((account) => (
        <li key={account.id}>
          <PublicAccountItem account={account} baseUrl={baseUrl} />
        </li>
      ))}
    </ul>
  );
}

interface PublicAccountItemProps {
  readonly account: Account;
  readonly baseUrl: URL | string;
}

function PublicAccountItem({ account, baseUrl }: PublicAccountItemProps) {
  const nameHtml = renderCustomEmojis(
    escape(account.name),
    account.emojis,
    baseUrl,
  );
  const bioHtml = renderCustomEmojis(
    sanitizeHtml(account.bioHtml ?? ""),
    account.emojis,
    baseUrl,
  );
  const href = account.url ?? account.iri;
  const avatar = proxyUrl(account.avatarUrl, baseUrl);
  return (
    <article class="flex items-start gap-4 py-6">
      <a href={href} aria-label={account.name} class="shrink-0">
        {avatar ? (
          <img
            src={avatar}
            alt=""
            width={48}
            height={48}
            class="size-12 rounded-full object-cover"
          />
        ) : (
          <span class="block size-12 rounded-full bg-neutral-200 dark:bg-neutral-800" />
        )}
      </a>
      <div class="min-w-0 flex-1">
        <a
          href={href}
          class="block font-semibold text-neutral-900 hover:underline dark:text-neutral-100"
          dangerouslySetInnerHTML={{ __html: nameHtml }}
          aria-label={account.name}
        />
        <p class="select-all text-xs text-neutral-500 dark:text-neutral-400">
          {account.handle}
        </p>
        {bioHtml && (
          <div
            class="prose prose-sm prose-neutral dark:prose-invert prose-a:text-brand-700 dark:prose-a:text-brand-400 mt-2 max-w-none break-words"
            dangerouslySetInnerHTML={{ __html: bioHtml }}
          />
        )}
      </div>
    </article>
  );
}
