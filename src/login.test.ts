import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../tests/helpers";
import db from "./db";
import { SECRET_KEY } from "./env";
import { loginRequired } from "./login";
import { totps } from "./schema";

const app = new Hono();
app.use(loginRequired);
app.get("/protected", (c) => c.text("ok"));

async function signed(name: string, value: string): Promise<string> {
  return serializeSigned(name, value, SECRET_KEY!, { path: "/" });
}

describe("loginRequired", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("redirects to /login when no login cookie is present", async () => {
    const response = await app.request("/protected");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/^\/login\?next=/);
  });

  it("lets the request through when login is set and no TOTP is enrolled", async () => {
    const cookie = await signed("login", new Date().toISOString());
    const response = await app.request("/protected", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  describe("when a TOTP is enrolled", () => {
    beforeEach(async () => {
      await db.insert(totps).values({
        issuer: "Hollo",
        label: "test@example.com",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: "JBSWY3DPEHPK3PXP",
      });
    });

    it("redirects to /login/otp when login is set but no second factor", async () => {
      const cookie = await signed("login", new Date().toISOString());
      const response = await app.request("/protected", {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\/otp\?next=/);
    });

    it("lets the request through when the otp cookie matches the login cookie", async () => {
      const login = new Date().toISOString();
      const loginCookie = await signed("login", login);
      const otpCookie = await signed("otp", `${login} totp`);
      const response = await app.request("/protected", {
        headers: { Cookie: `${loginCookie}; ${otpCookie}` },
      });
      expect(response.status).toBe(200);
    });

    it("lets the request through when the passkey cookie matches the login cookie", async () => {
      const login = new Date().toISOString();
      const loginCookie = await signed("login", login);
      const passkeyCookie = await signed("passkey", `${login} passkey`);
      const response = await app.request("/protected", {
        headers: { Cookie: `${loginCookie}; ${passkeyCookie}` },
      });
      expect(response.status).toBe(200);
    });

    it("redirects to /login/otp when the otp cookie does not match the login cookie", async () => {
      const loginCookie = await signed("login", new Date().toISOString());
      const otpCookie = await signed("otp", "1999-01-01T00:00:00.000Z totp");
      const response = await app.request("/protected", {
        headers: { Cookie: `${loginCookie}; ${otpCookie}` },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\/otp\?next=/);
    });

    it("redirects to /login/otp when the passkey cookie does not match the login cookie", async () => {
      const loginCookie = await signed("login", new Date().toISOString());
      const passkeyCookie = await signed(
        "passkey",
        "1999-01-01T00:00:00.000Z passkey",
      );
      const response = await app.request("/protected", {
        headers: { Cookie: `${loginCookie}; ${passkeyCookie}` },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\/otp\?next=/);
    });
  });
});
