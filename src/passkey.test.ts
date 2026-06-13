import { describe, expect, it, vi } from "vitest";

import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  decodePublicKey,
  encodePublicKey,
  getRpInfo,
  nicknameFromUserAgent,
  sanitizeTransports,
  userIdFromEmail,
  verifyAuthentication,
  verifyRegistration,
} from "./passkey";

vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>(
    "@simplewebauthn/server",
  );
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

const {
  verifyRegistrationResponse: mockVerifyRegistration,
  verifyAuthenticationResponse: mockVerifyAuthentication,
} = await import("@simplewebauthn/server");

describe("getRpInfo", () => {
  it("returns hostname and origin from a same-origin URL", () => {
    const info = getRpInfo("https://hollo.example/auth/passkeys/begin");
    expect(info).toEqual({
      rpID: "hollo.example",
      origin: "https://hollo.example",
    });
  });

  it("strips port and path from the origin string but keeps an explicit port", () => {
    const info = getRpInfo("http://localhost:3000/login/passkey/begin?x=1");
    expect(info).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
  });

  it("uses the request URL's hostname when split-domain (the web origin)", () => {
    // In split-domain mode the login + admin pages are served from the web
    // origin (e.g. dorikom.hollo.social) while ActivityPub lives on a
    // separate host (ap.hollo.social).  Passkey ceremonies always happen
    // on the web origin, so the rpID comes from the request hostname.
    const info = getRpInfo("https://dorikom.hollo.social/auth");
    expect(info.rpID).toBe("dorikom.hollo.social");
    expect(info.origin).toBe("https://dorikom.hollo.social");
  });

  it("accepts a URL instance as well as a string", () => {
    const info = getRpInfo(new URL("https://hollo.example/foo"));
    expect(info.rpID).toBe("hollo.example");
  });
});

describe("userIdFromEmail", () => {
  it("returns a 32-byte SHA-256 digest", async () => {
    const id = await userIdFromEmail("alice@example.com");
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(32);
  });

  it("is deterministic and case-insensitive", async () => {
    const a = await userIdFromEmail("Alice@Example.com");
    const b = await userIdFromEmail("alice@example.com");
    expect(a).toEqual(b);
  });

  it("differs for different emails", async () => {
    const a = await userIdFromEmail("alice@example.com");
    const b = await userIdFromEmail("bob@example.com");
    expect(a).not.toEqual(b);
  });
});

describe("encodePublicKey / decodePublicKey", () => {
  it("round-trips arbitrary byte sequences", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = encodePublicKey(bytes);
    expect(typeof encoded).toBe("string");
    expect(Array.from(decodePublicKey(encoded))).toEqual(Array.from(bytes));
  });

  it("encodes to base64url (no +, /, or = padding)", () => {
    const bytes = new Uint8Array([255, 255, 255, 255, 255]);
    const encoded = encodePublicKey(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("decodes the same value when given a string with padding stripped", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = encodePublicKey(bytes);
    expect(Array.from(decodePublicKey(encoded))).toEqual(Array.from(bytes));
  });
});

describe("sanitizeTransports", () => {
  it("keeps the values WebAuthn defines", () => {
    expect(
      sanitizeTransports([
        "internal",
        "hybrid",
        "usb",
        "nfc",
        "ble",
        "cable",
        "smart-card",
      ]),
    ).toEqual([
      "internal",
      "hybrid",
      "usb",
      "nfc",
      "ble",
      "cable",
      "smart-card",
    ]);
  });

  it("drops unknown transport hints", () => {
    expect(
      sanitizeTransports(["internal", "totally-fake", "DROP TABLE passkeys"]),
    ).toEqual(["internal"]);
  });

  it("returns [] for undefined input", () => {
    expect(sanitizeTransports(undefined)).toEqual([]);
  });
});

describe("nicknameFromUserAgent", () => {
  it("falls back to 'Passkey' for null/empty input", () => {
    expect(nicknameFromUserAgent(null)).toBe("Passkey");
    expect(nicknameFromUserAgent(undefined)).toBe("Passkey");
    expect(nicknameFromUserAgent("")).toBe("Passkey");
    expect(nicknameFromUserAgent("   ")).toBe("Passkey");
  });

  it("labels common platforms", () => {
    expect(
      nicknameFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      ),
    ).toContain("macOS");
    expect(
      nicknameFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ),
    ).toContain("Windows");
    expect(
      nicknameFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      ),
    ).toContain("iOS");
    expect(
      nicknameFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
      ),
    ).toContain("Android");
    expect(
      nicknameFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      ),
    ).toContain("Linux");
  });

  it("returns 'Passkey' for an unrecognized UA", () => {
    expect(nicknameFromUserAgent("some-random-thing/1.0")).toBe("Passkey");
  });
});

describe("buildRegistrationOptions", () => {
  it("populates rp, user, and authenticator selection from inputs", async () => {
    const { options, challenge } = await buildRegistrationOptions({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      email: "alice@example.com",
      existingCredentials: [],
    });
    expect(options.rp.id).toBe("hollo.example");
    expect(options.rp.name).toBe("Hollo");
    expect(options.user.name).toBe("alice@example.com");
    expect(options.user.displayName).toBe("alice@example.com");
    expect(typeof options.user.id).toBe("string");
    expect(options.challenge).toBe(challenge);
    expect(options.authenticatorSelection?.residentKey).toBe("required");
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.attestation).toBe("none");
  });

  it("threads excludeCredentials through", async () => {
    const { options } = await buildRegistrationOptions({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      email: "alice@example.com",
      existingCredentials: [
        { id: "abc-123", transports: ["internal", "hybrid"] },
        { id: "def-456" },
      ],
    });
    expect(options.excludeCredentials).toEqual([
      { id: "abc-123", transports: ["internal", "hybrid"], type: "public-key" },
      { id: "def-456", type: "public-key" },
    ]);
  });
});

describe("buildAuthenticationOptions", () => {
  it("emits options with the configured rpID and no allowCredentials by default", async () => {
    const { options, challenge } = await buildAuthenticationOptions({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
    });
    expect(options.rpId).toBe("hollo.example");
    expect(options.allowCredentials).toBeUndefined();
    expect(options.challenge).toBe(challenge);
    expect(options.userVerification).toBe("required");
  });

  it("threads allowedCredentials through", async () => {
    const { options } = await buildAuthenticationOptions({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      allowedCredentials: [{ id: "abc-123", transports: ["internal"] }],
    });
    expect(options.allowCredentials).toEqual([
      { id: "abc-123", transports: ["internal"], type: "public-key" },
    ]);
  });
});

describe("verifyRegistration", () => {
  it("returns the credential ready for insert when verification succeeds", async () => {
    vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: {
          id: "cred-id-1",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
        },
        credentialType: "public-key",
        attestationObject: new Uint8Array(0),
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://hollo.example",
        rpID: "hollo.example",
      },
    });
    const result = await verifyRegistration({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      response: {
        id: "cred-id-1",
        rawId: "cred-id-1",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: "",
          attestationObject: "",
          transports: ["internal"],
        },
      },
      expectedChallenge: "challenge-abc",
    });
    expect(result).toEqual({
      credentialId: "cred-id-1",
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 0,
      transports: ["internal"],
      deviceType: "multiDevice",
      backedUp: true,
    });
  });

  it("returns null when SimpleWebAuthn rejects the response", async () => {
    vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
      verified: false,
    });
    const result = await verifyRegistration({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      response: {
        id: "x",
        rawId: "x",
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: "", attestationObject: "" },
      },
      expectedChallenge: "challenge",
    });
    expect(result).toBeNull();
  });

  it("returns null when SimpleWebAuthn throws (malformed response, etc.)", async () => {
    vi.mocked(mockVerifyRegistration).mockRejectedValueOnce(
      new Error("Unexpected RP ID hash"),
    );
    const result = await verifyRegistration({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      response: {
        id: "x",
        rawId: "x",
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: "", attestationObject: "" },
      },
      expectedChallenge: "challenge",
    });
    expect(result).toBeNull();
  });
});

describe("verifyAuthentication", () => {
  it("returns the new counter when verification succeeds", async () => {
    vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-id-1",
        newCounter: 42,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://hollo.example",
        rpID: "hollo.example",
      },
    });
    const result = await verifyAuthentication({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      response: {
        id: "cred-id-1",
        rawId: "cred-id-1",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: "",
          authenticatorData: "",
          signature: "",
        },
      },
      expectedChallenge: "challenge-abc",
      storedPasskey: {
        id: "cred-id-1",
        publicKey: encodePublicKey(new Uint8Array([1, 2, 3, 4])),
        counter: 10,
        transports: ["internal"],
      },
    });
    expect(result).toEqual({ newCounter: 42 });
  });

  it("returns null when SimpleWebAuthn rejects the assertion", async () => {
    vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
      verified: false,
      authenticationInfo: {
        credentialID: "cred-id-1",
        newCounter: 0,
        userVerified: false,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "https://hollo.example",
        rpID: "hollo.example",
      },
    });
    const result = await verifyAuthentication({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      response: {
        id: "cred-id-1",
        rawId: "cred-id-1",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: "",
          authenticatorData: "",
          signature: "",
        },
      },
      expectedChallenge: "challenge-abc",
      storedPasskey: {
        id: "cred-id-1",
        publicKey: encodePublicKey(new Uint8Array([1, 2, 3, 4])),
        counter: 10,
        transports: ["internal"],
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when SimpleWebAuthn throws (counter rollback, etc.)", async () => {
    vi.mocked(mockVerifyAuthentication).mockRejectedValueOnce(
      new Error("Response signature invalid"),
    );
    const result = await verifyAuthentication({
      rpInfo: { rpID: "hollo.example", origin: "https://hollo.example" },
      response: {
        id: "cred-id-1",
        rawId: "cred-id-1",
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: "",
          authenticatorData: "",
          signature: "",
        },
      },
      expectedChallenge: "challenge-abc",
      storedPasskey: {
        id: "cred-id-1",
        publicKey: encodePublicKey(new Uint8Array([1, 2, 3, 4])),
        counter: 10,
        transports: ["internal"],
      },
    });
    expect(result).toBeNull();
  });
});
