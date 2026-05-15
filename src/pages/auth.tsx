import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { HOTP, TOTP } from "otpauth";
import { z } from "zod";

import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import { SECRET_KEY } from "../env";
import { loginRequired } from "../login";
import {
  buildRegistrationOptions,
  encodePublicKey,
  getRpInfo,
  nicknameFromUserAgent,
  verifyRegistration,
} from "../passkey";
import { type Passkey, passkeys, type Totp, totps } from "../schema";

const logger = getLogger(["hollo", "pages", "auth"]);

const PASSKEY_REG_COOKIE = "passkey_reg";
const PASSKEY_REG_MAX_AGE_SECONDS = 5 * 60;

const auth = new Hono();

auth.use(loginRequired);

auth.get("/", async (c) => {
  const totp = await db.query.totps.findFirst();
  const passkeysList = await db.query.passkeys.findMany({
    orderBy: (p, { desc }) => [desc(p.created)],
  });
  const open = c.req.query("open");
  if (totp == null && open === "2fa") {
    const credential = await db.query.credentials.findFirst();
    if (credential == null) return c.redirect("/setup");
    const { Secret, TOTP } = await import("otpauth");
    const totp = new TOTP({
      issuer: "Hollo",
      label: credential.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: new Secret({ size: 20 }),
    });
    logger.debug("The TOTP token: {token}", { token: totp.generate() });
    return c.html(<AuthPage tfa={{ totp }} passkeys={passkeysList} />);
  }
  return c.html(<AuthPage totp={totp} passkeys={passkeysList} />);
});

auth.post(
  "/2fa",
  zValidator(
    "form",
    z.object({ totp: z.url(), token: z.string().regex(/^\d+$/) }),
  ),
  async (c) => {
    const form = c.req.valid("form");
    const { HOTP, URI } = await import("otpauth");
    const totp = URI.parse(form.totp);
    const passkeysList = await db.query.passkeys.findMany({
      orderBy: (p, { desc }) => [desc(p.created)],
    });
    if (totp instanceof HOTP) {
      return c.html(
        <AuthPage
          tfa={{ totp, error: "HOTP is not supported." }}
          passkeys={passkeysList}
        />,
      );
    }
    const validated = totp.validate({
      token: form.token,
      window: 2,
    });
    if (validated == null) {
      return c.html(
        <AuthPage
          tfa={{ totp, error: "The code you entered is invalid." }}
          passkeys={passkeysList}
        />,
      );
    }
    await db.insert(totps).values({
      ...totp,
      secret: totp.secret.base32,
    });
    return c.redirect("/auth");
  },
);

auth.post("/2fa/disable", async (c) => {
  await db.delete(totps);
  return c.redirect("/auth");
});

auth.post("/passkeys/registration/begin", async (c) => {
  const login = await getSignedCookie(c, SECRET_KEY, "login");
  // loginRequired ran already, but TypeScript can't narrow that, and the
  // double check costs nothing.
  if (login == null || login === false) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`);
  }
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.redirect("/setup");
  const enrolled = await db.query.passkeys.findMany({
    columns: { id: true, transports: true },
  });
  const rpInfo = getRpInfo(c.req.url);
  const { options, challenge } = await buildRegistrationOptions({
    rpInfo,
    email: credential.email,
    existingCredentials: enrolled.map((p) => ({
      id: p.id,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
  });
  const expiresAt = Date.now() + PASSKEY_REG_MAX_AGE_SECONDS * 1000;
  // The signed cookie binds the challenge to (a) the current login
  // session and (b) a server-enforced expiry, so a captured cookie
  // can't be replayed after logout or after the TTL even though
  // Max-Age is only a browser hint.  The pipe character is not part
  // of base64url (the challenge encoding), so it's safe as a
  // separator.
  const value = `${challenge}|${expiresAt.toString()}|${login}`;
  await setSignedCookie(c, PASSKEY_REG_COOKIE, value, SECRET_KEY, {
    httpOnly: true,
    secure: rpInfo.origin.startsWith("https://"),
    sameSite: "Strict",
    path: "/auth/passkeys",
    maxAge: PASSKEY_REG_MAX_AGE_SECONDS,
  });
  return c.json(options);
});

const finishBodySchema = z.object({
  nickname: z.string().trim().max(80).optional(),
  registrationResponse: z.object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().optional(),
    response: z.object({
      clientDataJSON: z.string(),
      attestationObject: z.string(),
      authenticatorData: z.string().optional(),
      publicKey: z.string().optional(),
      publicKeyAlgorithm: z.number().optional(),
      transports: z.array(z.string()).optional(),
    }),
  }),
});

auth.post("/passkeys/registration/finish", async (c) => {
  const login = await getSignedCookie(c, SECRET_KEY, "login");
  if (login == null || login === false) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`);
  }
  // Consume the registration challenge cookie up front, before any body
  // parsing or schema validation, so a malformed first request still
  // burns the cookie.  Otherwise zValidator would short-circuit on a bad
  // payload and leave passkey_reg replayable until its TTL.
  const cookieValue = await getSignedCookie(c, SECRET_KEY, PASSKEY_REG_COOKIE);
  deleteCookie(c, PASSKEY_REG_COOKIE, { path: "/auth/passkeys" });
  if (cookieValue == null || cookieValue === false) {
    return c.json({ error: "Missing or invalid challenge cookie." }, 400);
  }
  const parts = cookieValue.split("|");
  if (parts.length !== 3) {
    return c.json({ error: "Malformed challenge cookie." }, 400);
  }
  const [challenge, expiresAtStr, boundLogin] = parts;
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return c.json({ error: "Challenge has expired." }, 400);
  }
  if (boundLogin !== login) {
    return c.json(
      { error: "Challenge is bound to a different login session." },
      400,
    );
  }
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.redirect("/setup");

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const parsed = finishBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body." }, 400);
  }
  const body = parsed.data;
  const rpInfo = getRpInfo(c.req.url);
  const verified = await verifyRegistration({
    rpInfo,
    // SimpleWebAuthn validates the inner shape; the Zod schema above
    // just rejects obviously wrong payloads.
    // oxlint-disable-next-line typescript/no-explicit-any
    response: body.registrationResponse as any,
    expectedChallenge: challenge,
  });
  if (verified == null) {
    return c.json({ error: "Registration could not be verified." }, 400);
  }
  const trimmedNickname = body.nickname?.trim();
  const nickname =
    trimmedNickname != null && trimmedNickname !== ""
      ? trimmedNickname
      : nicknameFromUserAgent(c.req.header("user-agent"));
  const inserted = await db
    .insert(passkeys)
    .values({
      id: verified.credentialId,
      credentialEmail: credential.email,
      publicKey: encodePublicKey(verified.publicKey),
      counter: verified.counter,
      transports: verified.transports,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      nickname,
    })
    .onConflictDoNothing()
    .returning({ id: passkeys.id });
  if (inserted.length === 0) {
    return c.json(
      { error: "This passkey is already enrolled on this account." },
      409,
    );
  }
  return c.body(null, 204);
});

auth.post("/passkeys/:id/delete", async (c) => {
  const id = c.req.param("id");
  await db.delete(passkeys).where(eq(passkeys.id, id));
  return c.redirect("/auth");
});

interface AuthPageProps {
  totp?: Totp;
  tfa?: {
    totp: TOTP | HOTP;
    error?: string;
  };
  passkeys: Passkey[];
}

async function AuthPage({ totp, tfa, passkeys }: AuthPageProps) {
  return (
    <DashboardLayout title="Hollo: Auth" selectedMenu="auth">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Authentication
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Manage how you sign in to this Hollo instance.
        </p>
      </header>

      <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Two-factor authentication (TOTP)
            </h2>
            <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
              Secure sign-in with a one-time code from an authenticator app like
              Google Authenticator or Authy.
            </p>
          </div>
          <span
            class={
              totp == null
                ? "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                : "inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300"
            }
          >
            <span
              class={
                totp == null
                  ? "size-1.5 rounded-full bg-neutral-400"
                  : "size-1.5 rounded-full bg-green-500"
              }
              aria-hidden="true"
            />
            {totp == null ? "Disabled" : "Enabled"}
          </span>
        </header>
        {totp == null ? (
          tfa == null ? (
            <a
              href="?open=2fa"
              class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
            >
              Enable two-factor authentication
            </a>
          ) : (
            <div class="space-y-4">
              <div class="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
                <div class="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
                  <img
                    src={await qrCode(tfa.totp.toString())}
                    alt="QR code for two-factor setup"
                    class="block size-40"
                  />
                </div>
                <div class="text-sm text-neutral-700 dark:text-neutral-300">
                  <p>Scan the QR code with your authenticator app.</p>
                  <details class="mt-3">
                    <summary class="cursor-pointer text-brand-700 hover:underline dark:text-brand-400">
                      Can't scan? Copy the setup URL instead.
                    </summary>
                    <input
                      type="text"
                      value={tfa.totp.toString()}
                      readonly
                      class="mt-2 w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                    />
                  </details>
                </div>
              </div>
              <form method="post" action="/auth/2fa" class="space-y-2">
                <p class="text-sm text-neutral-700 dark:text-neutral-300">
                  Enter the six-digit code to confirm setup:
                </p>
                <div class="flex gap-2">
                  <input
                    type="hidden"
                    name="totp"
                    value={tfa.totp.toString()}
                  />
                  <input
                    type="text"
                    name="token"
                    inputmode="numeric"
                    pattern="^[0-9]+$"
                    required
                    placeholder="123456"
                    aria-invalid={tfa.error == null ? undefined : "true"}
                    class={`flex-1 rounded-md border bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 ${
                      tfa.error == null
                        ? "border-neutral-300 dark:border-neutral-700"
                        : "border-red-500 dark:border-red-500"
                    }`}
                  />
                  <button
                    type="submit"
                    class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
                  >
                    Verify
                  </button>
                </div>
                {tfa.error && (
                  <p class="text-xs text-red-600 dark:text-red-400">
                    {tfa.error}
                  </p>
                )}
              </form>
            </div>
          )
        ) : (
          <form
            method="post"
            action="/auth/2fa/disable"
            onsubmit="return window.confirm('Are you sure you want to disable two-factor authentication? This will remove the two-factor authentication from your account.');"
          >
            <button
              type="submit"
              class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              Disable two-factor authentication
            </button>
          </form>
        )}
      </section>

      <section class="mt-6 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Passkeys
            </h2>
            <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
              Sign in without a password using a device-bound key plus a
              biometric or PIN. A passkey on its own counts as multi-factor
              authentication, so the TOTP step is skipped.
            </p>
          </div>
          <span
            class={
              passkeys.length === 0
                ? "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                : "inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300"
            }
          >
            <span
              class={
                passkeys.length === 0
                  ? "size-1.5 rounded-full bg-neutral-400"
                  : "size-1.5 rounded-full bg-green-500"
              }
              aria-hidden="true"
            />
            {passkeys.length === 0
              ? "None enrolled"
              : `${passkeys.length.toString()} enrolled`}
          </span>
        </header>

        {passkeys.length === 0 ? (
          <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
            No passkeys are enrolled yet. Enrolling one lets you sign in from
            this browser without typing your password.
          </p>
        ) : (
          <ul class="mb-4 divide-y divide-neutral-200 dark:divide-neutral-800">
            {passkeys.map((p) => (
              <li class="flex flex-wrap items-center justify-between gap-3 py-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {p.nickname}
                  </p>
                  <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Added {formatDate(p.created)}
                    {p.lastUsed != null
                      ? ` · last used ${formatDate(p.lastUsed)}`
                      : " · never used"}
                  </p>
                </div>
                <form
                  method="post"
                  action={`/auth/passkeys/${encodeURIComponent(p.id)}/delete`}
                  class="m-0"
                  onsubmit="return window.confirm('Remove this passkey?  You will not be able to sign in with it after this.');"
                >
                  <button
                    type="submit"
                    class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form id="passkey-enroll-form" class="space-y-3">
          <label
            class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            for="passkey-nickname"
          >
            Nickname
            <span class="ms-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
              optional
            </span>
          </label>
          <input
            id="passkey-nickname"
            name="nickname"
            type="text"
            maxLength={80}
            placeholder="e.g. iPhone, work laptop, YubiKey"
            class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900"
          />
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
            >
              Add passkey
            </button>
            <p
              id="passkey-enroll-status"
              class="text-xs text-neutral-500 dark:text-neutral-400"
              aria-live="polite"
            />
          </div>
        </form>
      </section>

      <script src="/public/simplewebauthn-browser.umd.js" defer />
      <script src="/public/passkey.js" defer />
    </DashboardLayout>
  );
}

function formatDate(value: Date): string {
  // toISOString() produces a stable, locale-independent string; the browser
  // can fancy this up later if needed.  Using just the date portion keeps
  // the list scannable.
  return value.toISOString().slice(0, 10);
}

function qrCode(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      const { toDataURL } = await import("qrcode");
      toDataURL(data, (err, url) => {
        if (err != null) return reject(err);
        resolve(url);
      });
    };

    run().catch(reject);
  });
}

export default auth;
