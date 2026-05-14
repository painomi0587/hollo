import { proxyUrl } from "../media-proxy";
import type { Account, Reaction } from "../schema";

export function serializeEmojis(
  emojis: Record<string, string>,
  baseUrl: URL | string,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const [name, href] of Object.entries(emojis)) {
    const serialized = serializeEmoji(name, href, baseUrl);
    if (serialized != null) result.push(serialized);
  }
  return result;
}

// Returns null when `href` has a scheme that proxyUrl refuses to wrap (e.g.
// data:, javascript:).  Callers should treat that as "drop the emoji" rather
// than fall back to the raw href, since handing the raw href to a client
// defeats the proxy's safety guarantees.
export function serializeEmoji(
  name: string,
  href: string,
  baseUrl: URL | string,
): Record<string, unknown> | null {
  const proxied = proxyUrl(href, baseUrl);
  if (proxied == null) return null;
  return {
    shortcode: name.replace(/(^:)|(:$)/g, ""),
    url: proxied,
    static_url: proxied,
    visible_in_picker: false,
    category: null,
  };
}

export function serializeReaction(
  reaction: Reaction & { account: Account },
  currentAccountOwner: { id: string } | undefined | null,
  baseUrl: URL | string,
): Record<string, unknown> {
  const [result] = serializeReactions([reaction], currentAccountOwner, baseUrl);
  return result;
}

export function serializeReactions(
  reactions: (Reaction & { account: Account })[],
  currentAccountOwner: { id: string } | undefined | null,
  baseUrl: URL | string,
): Record<string, unknown>[] {
  const result: Record<
    string,
    { count: number; account_ids: string[]; me: boolean } & Record<
      string,
      unknown
    >
  > = {};
  for (const reaction of reactions) {
    // proxyUrl returning null means the customEmoji URL is unsafe to expose
    // (non-http(s)).  Treat it as a unicode-only reaction so the count is
    // still reflected without leaking the original href.
    const emojiUrl =
      reaction.customEmoji == null
        ? null
        : proxyUrl(reaction.customEmoji, baseUrl);
    const domain =
      emojiUrl == null
        ? null
        : reaction.account.handle.replace(/^@?[^@]+@/, "");
    const key =
      emojiUrl == null ? reaction.emoji : `${reaction.emoji}\n${domain}`;
    const me =
      currentAccountOwner != null &&
      reaction.account.id === currentAccountOwner.id;
    if (key in result) {
      result[key].count++;
      result[key].me ||= me;
      result[key].account_ids.push(reaction.account.id);
    } else if (emojiUrl == null) {
      result[key] = {
        name: reaction.emoji,
        me,
        count: 1,
        account_ids: [reaction.account.id],
      };
    } else {
      result[key] = {
        name: reaction.emoji.replace(/(^:)|(:$)/g, ""),
        domain,
        url: emojiUrl,
        static_url: emojiUrl,
        me,
        count: 1,
        account_ids: [reaction.account.id],
      };
    }
  }
  return Object.values(result);
}
