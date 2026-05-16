import { eq } from "drizzle-orm";
import * as timekeeper from "timekeeper";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import { credentials, passkeyLoginChallenges, passkeys } from "../schema";
import app from "./index";

vi.mock("../passkey", async () => {
  const actual =
    await vi.importActual<typeof import("../passkey")>("../passkey");
  return {
    ...actual,
    verifyAuthentication: vi.fn(),
  };
});

const { verifyAuthentication: mockVerifyAuthentication } =
  await import("../passkey");

const TEST_EMAIL = "owner@example.com";

async function seedCredential(): Promise<void> {
  await db.insert(credentials).values({
    email: TEST_EMAIL,
    passwordHash: "$argon2id$stub",
  });
}

async function seedPasskey(id = "cred-id-login"): Promise<void> {
  await db.insert(passkeys).values({
    id,
    credentialEmail: TEST_EMAIL,
    publicKey: "base64url-public-key",
    counter: 5,
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
    nickname: "My laptop",
  });
}

describe("login passkeys", () => {
  beforeEach(async () => {
    await cleanDatabase();
    // mockReset() (not just mockClear) drops any queued
    // mockResolvedValueOnce / mockImplementationOnce stacks left over
    // from a prior test — otherwise a follow-up test could pick up the
    // wrong one-shot return value.
    vi.mocked(mockVerifyAuthentication).mockReset();
  });

  describe("GET /login", () => {
    it("does not show the passkey button when none are enrolled", async () => {
      const response = await app.request("/login");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain("Sign in with passkey");
    });

    it("shows the passkey button when at least one is enrolled", async () => {
      await seedCredential();
      await seedPasskey();
      const response = await app.request("/login");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("Sign in with passkey");
      // The password form is still available behind a toggle.
      expect(body).toContain("Sign in with password");
    });

    it("opens the password form when the previous password attempt failed", async () => {
      await seedCredential();
      await seedPasskey();
      const response = await app.request("/login", {
        method: "POST",
        body: new URLSearchParams({
          email: "wrong@example.com",
          password: "wrong-password",
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const body = await response.text();
      // The <details> element rendering its `open` attribute means the
      // password form is visible by default after a failed attempt.
      expect(body).toMatch(/<details[^>]*\bopen\b/);
      expect(body).toContain("Invalid email or password.");
    });
  });

  describe("POST /login/passkey/begin", () => {
    it("returns 404 and does not insert a challenge when no passkeys are enrolled", async () => {
      const response = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      expect(response.status).toBe(404);
      const rows = await db.query.passkeyLoginChallenges.findMany();
      expect(rows).toEqual([]);
      // No transient cookie should be issued on this rejection path.
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).not.toMatch(/passkey_login=/);
    });

    it("evicts the oldest outstanding row instead of 429 when at cap", async () => {
      // An unauthenticated attacker should not be able to park the
      // table at the cap to lock out legitimate sign-ins.  When /begin
      // hits the cap it evicts the oldest unexpired row to make space
      // and still returns a fresh challenge.
      await seedCredential();
      await seedPasskey();
      const baseExpiry = Date.now() + 60_000;
      const rows = Array.from({ length: 64 }, (_, i) => ({
        id: `seeded-${i.toString().padStart(2, "0")}`,
        challenge: "seeded-challenge",
        // Older rows expire sooner, so the i=0 row is the FIFO head.
        expiresAt: new Date(baseExpiry + i * 1000),
      }));
      await db.insert(passkeyLoginChallenges).values(rows);

      const response = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Retry-After")).toBeNull();
      // Table size is unchanged (one evicted, one inserted).
      const total = await db.$count(passkeyLoginChallenges);
      expect(total).toBe(64);
      // The oldest seeded row is the one that got dropped.
      const evicted = await db.query.passkeyLoginChallenges.findFirst({
        where: { id: { eq: "seeded-00" } },
      });
      expect(evicted).toBeUndefined();
    });

    it("returns authn options and sets a challenge cookie when at least one is enrolled", async () => {
      await seedCredential();
      await seedPasskey();
      const response = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rpId: string;
        challenge: string;
        userVerification?: string;
      };
      expect(body.rpId).toBe("hollo.test");
      expect(typeof body.challenge).toBe("string");
      expect(body.userVerification).toBe("required");
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_login=/);
      expect(setCookie).toMatch(/HttpOnly/);
    });
  });

  describe("POST /login/passkey/finish", () => {
    it("rejects requests without a challenge cookie", async () => {
      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(400);
    });

    it("rejects assertions for unknown credential ids", async () => {
      // /begin needs at least one passkey enrolled to hand out a
      // challenge cookie; the actual credential id we send to /finish
      // is unrelated to it, which is the case under test.
      await seedCredential();
      await seedPasskey("a-different-cred");
      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";
      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            authenticationResponse: {
              id: "unknown-cred",
              rawId: "unknown-cred",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(mockVerifyAuthentication).not.toHaveBeenCalled();
    });

    it("sets login and passkey cookies and returns a redirect target on success", async () => {
      await seedCredential();
      await seedPasskey();
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
        newCounter: 12,
      });

      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            next: "/accounts",
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { redirect: string };
      expect(body.redirect).toBe("/accounts");

      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/login=/);
      expect(setCookie).toMatch(/passkey=/);
      // The transient challenge cookie is cleared.
      expect(setCookie).toMatch(/passkey_login=;/);

      // counter and lastUsed are updated on the row.
      const updated = await db.query.passkeys.findFirst({
        where: { id: { eq: "cred-id-login" } },
      });
      expect(updated?.counter).toBe(12);
      expect(updated?.lastUsed).not.toBeNull();
    });

    it("returns 400 when verification fails and does not update the counter", async () => {
      await seedCredential();
      await seedPasskey();
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce(null);

      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(400);
      const row = await db.query.passkeys.findFirst({
        where: { id: { eq: "cred-id-login" } },
      });
      expect(row?.counter).toBe(5);
      expect(row?.lastUsed).toBeNull();
    });

    it("rejects a replayed cookie + assertion pair (single-use challenge)", async () => {
      await seedCredential();
      await seedPasskey();

      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const finishBody = JSON.stringify({
        authenticationResponse: {
          id: "cred-id-login",
          rawId: "cred-id-login",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: "",
            authenticatorData: "",
            signature: "",
          },
        },
      });

      // First /finish: valid assertion + cookie → 200.
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
        newCounter: 12,
      });
      const first = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: finishBody,
        },
      );
      expect(first.status).toBe(200);

      // Second /finish with the same captured cookie: even within the
      // TTL it must be rejected because the server-side row was consumed.
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
        newCounter: 13,
      });
      const second = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: finishBody,
        },
      );
      expect(second.status).toBe(400);
      // verifyAuthentication must not even be called on the replay.
      expect(mockVerifyAuthentication).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when a concurrent assertion has already advanced the counter", async () => {
      await seedCredential();
      await seedPasskey();
      // Race: between the row SELECT and the compare-and-set UPDATE,
      // another assertion bumps the counter forward.  Using the verifier
      // mock as a hook point lets us inject that mutation deterministically.
      vi.mocked(mockVerifyAuthentication).mockImplementationOnce(async () => {
        await db
          .update(passkeys)
          .set({ counter: 9 })
          .where(eq(passkeys.id, "cred-id-login"));
        return { newCounter: 10 };
      });

      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(409);
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      // login / passkey cookies must NOT be set on a 409 path.
      expect(setCookie).not.toMatch(/(^|;\s*)login=/);
      expect(setCookie).not.toMatch(/(^|;\s*)passkey=/);
    });

    it("rejects a backslash-prefixed next URL (open-redirect guard)", async () => {
      await seedCredential();
      await seedPasskey();
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
        newCounter: 12,
      });
      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            next: "/\\evil.example/path",
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { redirect: string };
      expect(body.redirect).toBe("/");
    });

    it("rejects a stale challenge cookie even before the browser drops it", async () => {
      await seedCredential();
      await seedPasskey();

      // Reach into the in-memory state: ask /begin for a fresh challenge,
      // capture the signed cookie, then time-travel past the TTL.
      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      // Move past the 5-minute server-side expiry without waiting in real
      // time.  timekeeper mocks both Date.now() and `new Date()` (the
      // SQL expiry predicate constructs a Date directly).
      timekeeper.travel(new Date(Date.now() + 6 * 60_000));
      try {
        const response = await app.request(
          "http://hollo.test/login/passkey/finish",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: challengeCookie,
            },
            body: JSON.stringify({
              authenticationResponse: {
                id: "cred-id-login",
                rawId: "cred-id-login",
                type: "public-key",
                clientExtensionResults: {},
                response: {
                  clientDataJSON: "",
                  authenticatorData: "",
                  signature: "",
                },
              },
            }),
          },
        );
        expect(response.status).toBe(400);
        expect(mockVerifyAuthentication).not.toHaveBeenCalled();
      } finally {
        timekeeper.reset();
      }
    });

    it("rejects an external next URL", async () => {
      await seedCredential();
      await seedPasskey();
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
        newCounter: 12,
      });

      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            next: "https://evil.example/phish",
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { redirect: string };
      expect(body.redirect).toBe("/");
    });

    it("rejects a same-origin next URL whose pathname starts with //", async () => {
      // The WHATWG URL parser normalises "/.//evil.example/x" into pathname
      // "//evil.example/x" against the request origin, so the existing
      // origin check passes but window.location.assign would still treat
      // the result as protocol-relative.
      await seedCredential();
      await seedPasskey();
      vi.mocked(mockVerifyAuthentication).mockResolvedValueOnce({
        newCounter: 12,
      });

      const beginResponse = await app.request(
        "http://hollo.test/login/passkey/begin",
        { method: "POST" },
      );
      const challengeCookie =
        beginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

      const response = await app.request(
        "http://hollo.test/login/passkey/finish",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: challengeCookie,
          },
          body: JSON.stringify({
            next: "/.//evil.example/phish",
            authenticationResponse: {
              id: "cred-id-login",
              rawId: "cred-id-login",
              type: "public-key",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "",
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { redirect: string };
      expect(body.redirect).toBe("/");
    });
  });
});
