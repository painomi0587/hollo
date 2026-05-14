import { HANDLE_HOST, WEB_ORIGIN } from "./env";
import { normalizeHandle } from "./patterns";

const WEB_ORIGIN_HOST =
  WEB_ORIGIN != null ? new URL(WEB_ORIGIN).host.toLowerCase() : undefined;

export function getInstanceHost(fallback: URL | string): string {
  if (HANDLE_HOST != null) return HANDLE_HOST;
  return typeof fallback === "string" ? fallback : fallback.host;
}

export function isLocalHost(host: string, requestUrl: URL): boolean {
  const lower = host.toLowerCase();
  if (lower === requestUrl.host.toLowerCase()) return true;
  if (HANDLE_HOST != null && lower === HANDLE_HOST) return true;
  if (WEB_ORIGIN_HOST != null && lower === WEB_ORIGIN_HOST) return true;
  return false;
}

/**
 * Canonicalize a user-supplied handle-like string for an `accounts.handle`
 * lookup.  Strips a leading `@`, fills in the configured handle host for
 * bare usernames, and rewrites local-host aliases (the request host, the
 * configured `WEB_ORIGIN` host) to the canonical `HANDLE_HOST` form that
 * local accounts are stored under.  Remote handles are returned with a
 * leading `@` but otherwise untouched.
 */
export function normalizeHandleForLookup(
  handle: string,
  requestUrl: URL,
): string {
  const acct = normalizeHandle(handle);
  const at = acct.lastIndexOf("@");
  if (at < 0) {
    return `@${acct}@${getInstanceHost(requestUrl)}`;
  }
  if (isLocalHost(acct.slice(at + 1), requestUrl)) {
    return `@${acct.slice(0, at)}@${getInstanceHost(requestUrl)}`;
  }
  return `@${acct}`;
}
