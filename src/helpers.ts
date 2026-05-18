import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { base64 } from "@hexagon/base64";
import type { HonoRequest } from "hono";
import type z from "zod";

export async function requestBody<T extends z.ZodType = z.ZodTypeAny>(
  req: HonoRequest,
  schema: T,
  // biome-ignore lint/suspicious/noExplicitAny: Input type is `any` as it comes from the request
): Promise<z.ZodSafeParseSuccess<z.output<T>> | z.ZodSafeParseError<any>> {
  const contentType = req.header("Content-Type")?.toLowerCase();
  if (
    contentType === "application/json" ||
    contentType?.startsWith("application/json")
  ) {
    const json = await req.json();
    return await schema.safeParseAsync(json);
  }

  // Some clients (like Lobsters' Sponge) don't set Content-Type header for
  // POST requests with form data. In this case, Hono's parseBody() returns
  // an empty object because it defaults to text/plain.
  // We need to manually parse the body as URL-encoded form data.
  if (
    contentType === undefined ||
    contentType === "text/plain" ||
    contentType.startsWith("text/plain;")
  ) {
    const text = await req.text();
    if (text?.includes("=")) {
      const params = new URLSearchParams(text);
      const parsed: Record<string, string> = {};
      for (const [key, value] of params) {
        parsed[key] = value;
      }
      return await schema.safeParseAsync(parsed);
    }
  }

  const formData = await req.parseBody();
  return await schema.safeParseAsync(formData);
}

// URL safe in ABNF is: ALPHA / DIGIT / "-" / "." / "_" / "~"
export const URL_SAFE_REGEXP = /[A-Za-z0-9_\-.~]/;

export function base64Url(buffer: ArrayBuffer) {
  return base64.fromArrayBuffer(buffer, true);
}

export function randomBytes(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)).buffer);
}

/**
 * Constant-time comparison of two UTF-8 strings. Use this whenever one of
 * the inputs is a secret (OAuth client secret, signed-cookie material, an
 * authorization code, etc.) to avoid leaking the contents of the secret
 * through response timing.
 *
 * `node:crypto`'s `timingSafeEqual` itself requires equal-length inputs,
 * so the byte-length comparison below is unavoidable.  The UTF-8 encode
 * step is *not* a constant-time primitive over the string contents; the
 * helper is intended for ASCII/URL-safe token material (OAuth secrets,
 * PKCE challenges, signed-cookie strings) where that is acceptable.
 * Callers handling raw secret byte buffers should call
 * `crypto.timingSafeEqual` directly instead.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
