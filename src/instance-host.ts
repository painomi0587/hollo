import { HANDLE_HOST, WEB_ORIGIN } from "./env";

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
