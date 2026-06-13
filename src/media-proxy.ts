import { createHmac, timingSafeEqual } from "node:crypto";

import { SECRET_KEY } from "./env";
import { DRIVE_DISK, STORAGE_URL_BASE } from "./storage-config";

export type MediaProxyMode = "off" | "proxy" | "cache";

const TRUTHY_VALUES = new Set(["on", "true", "1"]);
const FALSY_VALUES = new Set(["off", "false", "0"]);

export function parseMediaProxyMode(value: string | undefined): MediaProxyMode {
  if (value === undefined) return "off";
  const lower = value.toLowerCase();
  if (lower === "proxy" || lower === "cache") return lower;
  // Boolean synonyms: `true`/`on`/`1` enable URL rewriting without on-disk
  // caching (the simpler "yes" answer); operators who want the disk cache
  // opt in explicitly with `cache`.  `false`/`off`/`0` mean off.
  if (TRUTHY_VALUES.has(lower)) return "proxy";
  if (FALSY_VALUES.has(lower)) return "off";
  throw new Error(
    `Unknown MEDIA_PROXY value: '${value}'. ` +
      "Expected 'off', 'proxy', 'cache', or a boolean ('true'/'false', " +
      "'on'/'off', '1'/'0').",
  );
}

export function parseRemoteMediaThumbnails(value: string | undefined): boolean {
  if (value === undefined) return true;
  const lower = value.toLowerCase();
  if (TRUTHY_VALUES.has(lower)) return true;
  if (FALSY_VALUES.has(lower)) return false;
  throw new Error(
    `Unknown REMOTE_MEDIA_THUMBNAILS value: '${value}'. ` +
      "Expected a boolean ('true'/'false', 'on'/'off', '1'/'0').",
  );
}

export const MEDIA_PROXY: MediaProxyMode = parseMediaProxyMode(
  // oxlint-disable-next-line typescript/dot-notation
  process.env["MEDIA_PROXY"],
);

export const REMOTE_MEDIA_THUMBNAILS: boolean = parseRemoteMediaThumbnails(
  // oxlint-disable-next-line typescript/dot-notation
  process.env["REMOTE_MEDIA_THUMBNAILS"],
);

export const PROXY_URL_PREFIX = "/proxy";

const SIGNING_KEY = createHmac("sha256", SECRET_KEY)
  .update("media-proxy/v1")
  .digest();

// HMAC-SHA256 truncated to 16 bytes (128 bits) — enough collision resistance
// against forgery while keeping URLs compact.
const SIGNATURE_BYTES = 16;

const URL_SAFE_REGEXP = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Buffer | null {
  if (!URL_SAFE_REGEXP.test(value)) return null;
  // Length mod 4 = 1 is impossible for canonical base64url output.
  if (value.length % 4 === 1) return null;
  const padded = value.padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(standard, "base64");
  } catch {
    return null;
  }
  // Reject non-canonical encodings (e.g. trailing-bit aliasing) by requiring
  // round-trip equality with the canonical encoder.
  if (base64UrlEncode(decoded) !== value) return null;
  return decoded;
}

function computeSignature(b64url: string): string {
  return base64UrlEncode(
    createHmac("sha256", SIGNING_KEY)
      .update(b64url)
      .digest()
      .subarray(0, SIGNATURE_BYTES),
  );
}

export function signProxyUrl(originalUrl: string): {
  sig: string;
  b64url: string;
} {
  const b64url = base64UrlEncode(Buffer.from(originalUrl, "utf-8"));
  return { sig: computeSignature(b64url), b64url };
}

export function verifyProxySignature(
  sig: string,
  b64url: string,
): string | null {
  if (!URL_SAFE_REGEXP.test(sig) || !URL_SAFE_REGEXP.test(b64url)) return null;
  const expected = base64UrlDecode(computeSignature(b64url));
  const provided = base64UrlDecode(sig);
  if (
    expected == null ||
    provided == null ||
    expected.length !== provided.length
  ) {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;
  const decoded = base64UrlDecode(b64url);
  if (decoded == null) return null;
  return decoded.toString("utf-8");
}

// The canonical "URL prefix we're willing to skip proxying for", derived from
// the configured asset storage.  We deliberately compare against the parsed
// URL's normalized `.href` (not the raw input string) so dot-segment tricks
// like `https://h/assets/../admin/avatar.png` and percent-encoded variants
// can't slip past the prefix check while resolving somewhere else.
//
//  -  In FS mode the driver always serves at `/assets/` on the storage
//     origin, regardless of any path component the operator put in
//     STORAGE_URL_BASE.  Trust only that namespace.
//  -  In S3 / generic mode the driver concatenates STORAGE_URL_BASE + "/" +
//     key, so STORAGE_URL_BASE itself (normalized to end in "/") is the
//     trusted namespace.
const TRUSTED_STORAGE_PREFIX: string | null = (() => {
  if (STORAGE_URL_BASE == null) return null;
  let storage: URL;
  try {
    storage = new URL(STORAGE_URL_BASE);
  } catch {
    return null;
  }
  if (DRIVE_DISK === "fs") {
    return new URL("/assets/", storage).href;
  }
  return storage.pathname.endsWith("/") ? storage.href : `${storage.href}/`;
})();

function isUnderStorageBase(parsed: URL): boolean {
  if (TRUSTED_STORAGE_PREFIX == null) return false;
  return parsed.href.startsWith(TRUSTED_STORAGE_PREFIX);
}

export function proxyUrlForMode(
  mode: MediaProxyMode,
  url: string | null | undefined,
  baseUrl: URL | string,
): string | null {
  if (url == null) return null;
  if (mode === "off") return url;
  const base = typeof baseUrl === "string" ? new URL(baseUrl) : baseUrl;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Non-absolute / unparseable strings can't be proxied; leave them so
    // callers that pass relative paths under their own origin keep working.
    return url;
  }
  // The proxy only fetches http(s).  Refuse to mint signed URLs for
  // data:/file:/javascript:/ftp:/etc. — and don't return them either, so a
  // caller that stored a hostile scheme falls back to its default.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Don't recurse if the URL is already a proxy URL on our own origin.
  if (
    parsed.origin === base.origin &&
    parsed.pathname.startsWith(`${PROXY_URL_PREFIX}/`)
  ) {
    return url;
  }
  // Skip URLs that resolve under the canonical asset storage namespace.
  // Comparing the parsed `.href` (not the raw input) is what makes the check
  // resistant to dot-segment / percent-encoded path traversal.
  if (isUnderStorageBase(parsed)) return url;
  const { sig, b64url } = signProxyUrl(url);
  return new URL(`${PROXY_URL_PREFIX}/${sig}/${b64url}`, base).href;
}

export function proxyUrl(
  url: string | null | undefined,
  baseUrl: URL | string,
): string | null {
  return proxyUrlForMode(MEDIA_PROXY, url, baseUrl);
}
