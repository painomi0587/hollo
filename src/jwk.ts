import { importJwk } from "@fedify/fedify";

export type JwkInput = JsonWebKey | string;

export function normalizeJsonWebKey(jwk: JwkInput): JsonWebKey {
  const parsed = typeof jwk === "string" ? JSON.parse(jwk) : jwk;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Invalid JWK");
  }
  return parsed;
}

export async function importHolloJwk(
  jwk: JwkInput,
  type: "private" | "public",
) {
  return await importJwk(normalizeJsonWebKey(jwk), type);
}
