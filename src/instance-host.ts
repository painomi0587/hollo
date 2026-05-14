import { HANDLE_HOST } from "./env";

export function getInstanceHost(fallback: URL | string): string {
  if (HANDLE_HOST != null) return HANDLE_HOST;
  return typeof fallback === "string" ? fallback : fallback.host;
}
