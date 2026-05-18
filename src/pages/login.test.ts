import { hash } from "argon2";
import { Secret, TOTP } from "otpauth";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../tests/helpers";
import { getLoginCookie } from "../../tests/helpers/web";
import db from "../db";
import app from "../index";
import { credentials, totps } from "../schema";

async function seedCredential(email: string, password: string) {
  await db
    .insert(credentials)
    .values({ email, passwordHash: await hash(password) });
}

describe("POST /login", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("sets HttpOnly, SameSite=Lax, Path=/ on the login cookie", async () => {
    expect.assertions(5);
    const email = "admin@hollo.test";
    const password = "correct-horse-battery-staple";
    await seedCredential(email, password);

    const form = new URLSearchParams({ email, password });
    const response = await app.fetch(
      new Request("http://hollo.test/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
      }),
    );

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/(?:^|;\s*|^|\s)login=/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    // The test request is over plain http, so Secure must NOT be set.
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it("marks the login cookie Secure when the request is over https", async () => {
    expect.assertions(1);
    const email = "admin@hollo.test";
    const password = "correct-horse-battery-staple";
    await seedCredential(email, password);

    const form = new URLSearchParams({ email, password });
    const response = await app.fetch(
      new Request("https://hollo.test/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
      }),
    );

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/Secure/i);
  });
});

async function seedTotp() {
  const secret = new Secret({ size: 20 });
  await db.insert(totps).values({
    issuer: "Hollo",
    label: "admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: secret.base32,
  });
  return new TOTP({
    issuer: "Hollo",
    label: "admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
}

describe("POST /login/otp", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("sets HttpOnly, SameSite=Lax, Path=/ on the otp cookie", async () => {
    expect.assertions(5);
    const totp = await seedTotp();
    const loginCookie = await getLoginCookie();

    const form = new URLSearchParams({ token: totp.generate() });
    const response = await app.fetch(
      new Request("http://hollo.test/login/otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: loginCookie,
        },
        body: form.toString(),
        redirect: "manual",
      }),
    );

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/(?:^|;\s*|\s)otp=/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it("marks the otp cookie Secure when the request is over https", async () => {
    expect.assertions(1);
    const totp = await seedTotp();
    const loginCookie = await getLoginCookie();

    const form = new URLSearchParams({ token: totp.generate() });
    const response = await app.fetch(
      new Request("https://hollo.test/login/otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: loginCookie,
        },
        body: form.toString(),
        redirect: "manual",
      }),
    );

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/Secure/i);
  });
});
