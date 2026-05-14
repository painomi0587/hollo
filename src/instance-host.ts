import { HANDLE_HOST, WEB_ORIGIN } from "./env";
import { normalizeHandle } from "./patterns";

// Use hostname (not host) so a non-default port on WEB_ORIGIN doesn't end
// up in the comparison value; fediverse handles never carry ports.
const WEB_ORIGIN_HOST =
  WEB_ORIGIN != null ? new URL(WEB_ORIGIN).hostname.toLowerCase() : undefined;

export function getInstanceHost(fallback: URL | string): string {
  if (HANDLE_HOST != null) return HANDLE_HOST;
  return typeof fallback === "string" ? fallback : fallback.host;
}

// String-equality check between hostnames; no DNS resolution and no
// authority over the request itself.  Used by lookup paths to decide
// whether a handle's host segment refers to this instance.
export function isLocalHost(host: string, requestUrl: URL): boolean {
  const lower = host.toLowerCase();
  // Accept both request URL forms: .host (with port) covers
  // non-split-domain deployments whose stored handles include the
  // port (e.g. local dev at localhost:3000), and .hostname (no port)
  // covers split-domain setups where HANDLE_HOST never carries one.
  if (lower === requestUrl.host.toLowerCase()) return true;
  if (lower === requestUrl.hostname.toLowerCase()) return true;
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
