import { describe, expect, it } from "vitest";

import { normalizeJsonWebKey } from "./jwk";

describe("normalizeJsonWebKey", () => {
  it("returns object JWK values unchanged", () => {
    expect.assertions(1);

    const jwk = { kty: "OKP", crv: "Ed25519", x: "test" };

    expect(normalizeJsonWebKey(jwk)).toBe(jwk);
  });

  it("parses string-encoded JWK values", () => {
    expect.assertions(1);

    const jwk = { kty: "OKP", crv: "Ed25519", x: "test" };

    expect(normalizeJsonWebKey(JSON.stringify(jwk))).toEqual(jwk);
  });

  it("rejects non-object JWK values", () => {
    expect.assertions(1);

    expect(() => normalizeJsonWebKey('"test"')).toThrow(TypeError);
  });
});
