import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { getLoginCookie } from "../../tests/helpers/web";
import db from "../db";
import { credentials, passkeys } from "../schema";
import app from "./index";

vi.mock("../passkey", async () => {
  const actual =
    await vi.importActual<typeof import("../passkey")>("../passkey");
  return {
    ...actual,
    verifyRegistration: vi.fn(),
  };
});

const { verifyRegistration: mockVerifyRegistration } =
  await import("../passkey");

const TEST_EMAIL = "owner@example.com";

async function seedCredential(): Promise<void> {
  await db.insert(credentials).values({
    email: TEST_EMAIL,
    passwordHash: await hash("hunter2hunter2"),
  });
}

describe("auth passkeys", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.mocked(mockVerifyRegistration).mockClear();
  });

  describe("POST /auth/passkeys/registration/begin", () => {
    it("redirects to /setup if no credential is configured", async () => {
      const cookie = await getLoginCookie();
      const response = await app.request("/auth/passkeys/registration/begin", {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/setup");
    });

    it("returns options JSON and sets a challenge cookie", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const response = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown> & {
        rp: { id: string; name: string };
        user: { name: string };
        challenge: string;
        authenticatorSelection?: {
          residentKey?: string;
          userVerification?: string;
        };
      };
      expect(body.rp.id).toBe("hollo.test");
      expect(body.rp.name).toBe("Hollo");
      expect(body.user.name).toBe(TEST_EMAIL);
      expect(typeof body.challenge).toBe("string");
      expect(body.authenticatorSelection?.residentKey).toBe("required");
      expect(body.authenticatorSelection?.userVerification).toBe("required");
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_reg=/);
      expect(setCookie).toMatch(/HttpOnly/);
    });

    it("requires a valid login cookie", async () => {
      await seedCredential();
      const response = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        { method: "POST" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\?next=/);
    });
  });

  describe("POST /auth/passkeys/registration/finish", () => {
    it("rejects requests without a challenge cookie", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const response = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "fake",
              rawId: "fake",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(response.status).toBe(400);
      const rows = await db.query.passkeys.findMany();
      expect(rows).toEqual([]);
    });

    it("inserts a passkey when verification succeeds", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();

      // First: hit /begin to receive a challenge cookie.
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      // Pretend the browser produced a valid response.
      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
        credentialId: "cred-id-abc",
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ["internal", "hybrid"],
        deviceType: "multiDevice",
        backedUp: true,
      });

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            nickname: "My Yubikey",
            registrationResponse: {
              id: "cred-id-abc",
              rawId: "cred-id-abc",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(204);
      const setCookie = finishResponse.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_reg=;/);

      const rows = await db.query.passkeys.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "cred-id-abc",
        credentialEmail: TEST_EMAIL,
        counter: 0,
        transports: ["internal", "hybrid"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "My Yubikey",
      });
    });

    it("returns 409 when the same credential id is enrolled twice", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        { method: "POST", headers: { Cookie: cookie } },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      // Pre-seed the duplicate to simulate "this passkey is already on file."
      await db.insert(passkeys).values({
        id: "duplicate-cred-id",
        credentialEmail: TEST_EMAIL,
        publicKey: "preexisting-key",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "Old entry",
      });

      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
        credentialId: "duplicate-cred-id",
        publicKey: new Uint8Array([9, 9, 9]),
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
      });

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "duplicate-cred-id",
              rawId: "duplicate-cred-id",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(409);
      const rows = await db.query.passkeys.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.nickname).toBe("Old entry");
    });

    it("rejects challenge cookies bound to a different login session", async () => {
      await seedCredential();
      const beginCookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        { method: "POST", headers: { Cookie: beginCookie } },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      // Different "login" timestamp -> different signed cookie value.
      await new Promise((r) => setTimeout(r, 5));
      const otherCookie = await getLoginCookie();

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${otherCookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "x",
              rawId: "x",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(400);
      expect(mockVerifyRegistration).not.toHaveBeenCalled();
    });

    it("returns 400 when verification fails", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        { method: "POST", headers: { Cookie: cookie } },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce(null);

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "x",
              rawId: "x",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(400);
      const rows = await db.query.passkeys.findMany();
      expect(rows).toEqual([]);
    });

    it("derives a friendly default nickname from the User-Agent", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        { method: "POST", headers: { Cookie: cookie } },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
        credentialId: "cred-id-def",
        publicKey: new Uint8Array([5, 6, 7, 8]),
        counter: 0,
        transports: [],
        deviceType: "singleDevice",
        backedUp: false,
      });

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "cred-id-def",
              rawId: "cred-id-def",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(204);
      const row = await db.query.passkeys.findFirst({
        where: eq(passkeys.id, "cred-id-def"),
      });
      expect(row?.nickname).toBe("macOS device");
    });

    it("consumes the challenge cookie even on a malformed body", async () => {
      // A malformed first request would previously short-circuit at the
      // schema validator before the cookie was deleted, leaving the same
      // signed value usable for the rest of its TTL.
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        { method: "POST", headers: { Cookie: cookie } },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
          },
          // The schema requires `registrationResponse`, so this body is
          // invalid and used to trip zValidator before the handler ran.
          body: JSON.stringify({ nickname: "no response" }),
        },
      );
      expect(finishResponse.status).toBe(400);
      const setCookie = finishResponse.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_reg=;/);
    });
  });

  describe("POST /auth/passkeys/:id/delete", () => {
    it("deletes the named passkey and redirects to /auth", async () => {
      await seedCredential();
      await db.insert(passkeys).values({
        id: "cred-to-remove",
        credentialEmail: TEST_EMAIL,
        publicKey: "public-key-base64url",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "Old phone",
      });
      const cookie = await getLoginCookie();
      const response = await app.request(
        "/auth/passkeys/cred-to-remove/delete",
        {
          method: "POST",
          headers: { Cookie: cookie },
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth");
      const rows = await db.query.passkeys.findMany();
      expect(rows).toEqual([]);
    });

    it("redirects to /auth even when the id does not exist", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const response = await app.request(
        "/auth/passkeys/does-not-exist/delete",
        {
          method: "POST",
          headers: { Cookie: cookie },
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth");
    });
  });

  describe("GET /auth", () => {
    it("renders a Passkeys section with the enrolled passkeys", async () => {
      await seedCredential();
      await db.insert(passkeys).values({
        id: "cred-listing",
        credentialEmail: TEST_EMAIL,
        publicKey: "public-key-base64url",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "My laptop",
      });
      const cookie = await getLoginCookie();
      const response = await app.request("/auth", {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Passkeys");
      expect(body).toContain("My laptop");
    });
  });
});
