import { randomUUID } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";

import { AuthCard } from "../components/AuthCard.tsx";
import { Layout } from "../components/Layout.tsx";
import { LoginForm } from "../components/LoginForm.tsx";
import { OtpForm } from "../components/OtpForm.tsx";
import { db } from "../db.ts";
import { SECRET_KEY } from "../env.ts";
import {
  buildAuthenticationOptions,
  getRpInfo,
  verifyAuthentication,
} from "../passkey.ts";
import { credentials, passkeyLoginChallenges, passkeys } from "../schema.ts";

const PASSKEY_LOGIN_COOKIE = "passkey_login";
const PASSKEY_LOGIN_MAX_AGE_SECONDS = 5 * 60;
// Hard cap on unexpired rows in `passkey_login_challenges`.  Hollo is a
// single-user instance, so even on a popular profile a handful of
// in-flight ceremonies at a time is the realistic ceiling — well below
// this number.  The cap exists to bound the table under unauthenticated
// abuse; when it's reached, /begin evicts the oldest unexpired row to
// make space rather than refusing the new request, so an attacker can
// never force a legitimate sign-in into 429.
const PASSKEY_LOGIN_MAX_OUTSTANDING_CHALLENGES = 64;
// Stable, arbitrary key for the Postgres advisory lock that serialises
// the GC + count + insert sequence inside /login/passkey/begin so the
// cap above can't be bypassed by a flurry of concurrent requests
// racing between the count and the insert.  The value is just an
// opaque integer; nothing else in the codebase shares it.
const PASSKEY_LOGIN_BEGIN_LOCK = 7626128400n;

/**
 * Accept only same-origin paths so `next=` can't be hijacked into an open
 * redirect.  Browsers normalise backslashes to forward slashes during URL
 * parsing (so `/\\evil/x` is treated like `//evil/x`), and historical
 * implementations have been bitten by `\\` and `/\` prefixes — parsing
 * against the current request origin and demanding the parsed origin match
 * is the safest filter.
 */
function safeNext(value: unknown, requestUrl: string | URL): string {
  if (typeof value !== "string" || value === "") return "/";
  let parsed: URL;
  try {
    parsed = new URL(value, requestUrl);
  } catch {
    return "/";
  }
  const base =
    requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl));
  if (parsed.origin !== base.origin) return "/";
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  // The origin check above catches `/\evil.com` style inputs (URL parsing
  // already moves the origin away from the request origin), but the WHATWG
  // URL spec normalises `/.//evil.com` into pathname `//evil.com` while
  // leaving the origin alone.  Returning that lets the browser treat the
  // redirect target as protocol-relative.  Refuse any pathname starting
  // with two slashes.
  return path.startsWith("//") ? "/" : path;
}

const login = new Hono();

login.get("/", async (c) => {
  const next = c.req.query("next");
  const passkeyCount = await db.$count(passkeys);
  return c.html(<LoginPage next={next} passkeyEnrolled={passkeyCount > 0} />);
});

login.post("/", async (c) => {
  const form = await c.req.formData();
  const email = form.get("email")?.toString();
  const password = form.get("password")?.toString();
  const next = form.get("next")?.toString();
  const passkeyCount = await db.$count(passkeys);
  const passkeyEnrolled = passkeyCount > 0;
  if (email == null || password == null) {
    return c.html(
      <LoginPage
        next={next}
        values={{ email }}
        errors={{
          email: email == null ? "Email is required." : undefined,
          password: password == null ? "Password is required." : undefined,
        }}
        passkeyEnrolled={passkeyEnrolled}
      />,
      400,
    );
  }
  const credential = await db.query.credentials.findFirst({
    where: eq(credentials.email, email),
  });
  const { verify } = await import("argon2");
  if (
    credential == null ||
    !(await verify(credential.passwordHash, password))
  ) {
    return c.html(
      <LoginPage
        next={next}
        values={{ email }}
        errors={{
          email: "Invalid email or password.",
          password: "Invalid email or password.",
        }}
        passkeyEnrolled={passkeyEnrolled}
      />,
      400,
    );
  }
  await setSignedCookie(c, "login", new Date().toISOString(), SECRET_KEY);
  return c.redirect(next ?? "/");
});

interface LoginPageProps {
  next?: string;
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
    password?: string;
  };
  passkeyEnrolled: boolean;
}

function LoginPage(props: LoginPageProps) {
  const hasPasswordError =
    props.errors?.email != null || props.errors?.password != null;
  return (
    <Layout title="Sign in to Hollo">
      <AuthCard
        title="Sign in to Hollo"
        subtitle="To continue, sign in with your Hollo account."
      >
        {props.passkeyEnrolled ? (
          <div class="space-y-3">
            <button
              type="button"
              id="passkey-signin-button"
              data-next={props.next ?? ""}
              class="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:bg-brand-700 dark:hover:bg-brand-800 dark:focus-visible:ring-offset-neutral-950"
            >
              Sign in with passkey
            </button>
            <p
              id="passkey-signin-status"
              class="text-center text-xs text-neutral-500 dark:text-neutral-400"
              aria-live="polite"
            />
            <details class="group" open={hasPasswordError}>
              <summary class="cursor-pointer text-center text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 group-open:mb-3">
                Sign in with password instead
              </summary>
              <LoginForm
                action="/login"
                next={props.next}
                values={props.values}
                errors={props.errors}
              />
            </details>
          </div>
        ) : (
          <LoginForm
            action="/login"
            next={props.next}
            values={props.values}
            errors={props.errors}
          />
        )}
      </AuthCard>
      {props.passkeyEnrolled && (
        <>
          <script src="/public/simplewebauthn-browser.umd.js" defer />
          <script src="/public/passkey.js" defer />
        </>
      )}
    </Layout>
  );
}

login.get(
  "/otp",
  zValidator(
    "query",
    z.object({
      next: z.url().optional(),
    }),
  ),
  (c) => {
    const query = c.req.valid("query");
    return c.html(<OtpPage next={query.next} />);
  },
);

login.post(
  "/otp",
  zValidator(
    "form",
    z.object({
      token: z.string().regex(/^\d+$/),
      next: z.url().optional(),
    }),
  ),
  async (c) => {
    const form = c.req.valid("form");
    const login = await getSignedCookie(c, SECRET_KEY, "login");
    if (login == null || login === false) {
      return c.redirect(`/login?next=${encodeURIComponent(form.next ?? "/")}`);
    }
    const totp = await db.query.totps.findFirst();
    if (totp == null) return c.redirect(form.next ?? "/");
    const { TOTP } = await import("otpauth");
    const totpInstance = new TOTP(totp);
    const valid = totpInstance.validate({
      token: form.token,
      window: 2,
    });
    if (valid == null) {
      return c.html(
        <OtpPage next={form.next} errors={{ token: "Invalid token." }} />,
      );
    }
    await setSignedCookie(c, "otp", `${login} totp`, SECRET_KEY);
    return c.redirect(form.next ?? "/");
  },
);

interface OtpPageProps {
  next?: string;
  errors?: {
    token?: string;
  };
}

function OtpPage(props: OtpPageProps) {
  return (
    <Layout title="Sign in to Hollo">
      <AuthCard
        title="Two-factor authentication"
        subtitle="Enter the six-digit code from your authenticator app."
      >
        <OtpForm action="/login/otp" next={props.next} errors={props.errors} />
      </AuthCard>
    </Layout>
  );
}

login.post("/passkey/begin", async (c) => {
  // /begin is reachable without a session, so it can't become a cheap
  // unauthenticated INSERT endpoint.  If no passkeys are enrolled there
  // is nothing for /finish to verify against either, so refuse early
  // and skip the DB write entirely.
  const passkeyCount = await db.$count(passkeys);
  if (passkeyCount === 0) {
    return c.json({ error: "No passkeys are enrolled on this server." }, 404);
  }
  const rpInfo = getRpInfo(c.req.url);
  const { options, challenge } = await buildAuthenticationOptions({ rpInfo });
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + PASSKEY_LOGIN_MAX_AGE_SECONDS * 1000);
  // GC + count + (evict +) insert are wrapped in one transaction
  // guarded by a Postgres advisory transaction lock, so concurrent
  // /begin requests serialise on the lock instead of racing between the
  // count and the insert.  This is the only place that takes this
  // lock, so contention is limited to this endpoint.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PASSKEY_LOGIN_BEGIN_LOCK})`,
    );
    // One timestamp for the whole transaction so the GC predicate and
    // the count predicate can't disagree if the wall clock ticks
    // between them.
    const now = new Date();
    // Opportunistically GC expired rows so the table never grows
    // unbounded even though Hollo doesn't run a separate cleanup
    // worker for it.
    await tx
      .delete(passkeyLoginChallenges)
      .where(lt(passkeyLoginChallenges.expiresAt, now));
    // Count after the GC so the cap reflects "still-usable" rows only.
    const outstanding = await tx.$count(
      passkeyLoginChallenges,
      gte(passkeyLoginChallenges.expiresAt, now),
    );
    // At the cap, evict the oldest unexpired row to make space.
    // Refusing the new request would let any unauthenticated caller
    // park the cap at 64 outstanding rows for the full TTL and force
    // every legitimate sign-in into 429; eviction keeps the table
    // bounded without that DoS surface.  An attacker can still race
    // the legitimate user's row out before /finish, but that's a much
    // harder attack than holding the door shut.
    if (outstanding >= PASSKEY_LOGIN_MAX_OUTSTANDING_CHALLENGES) {
      const oldest = await tx
        .select({ id: passkeyLoginChallenges.id })
        .from(passkeyLoginChallenges)
        .where(gte(passkeyLoginChallenges.expiresAt, now))
        .orderBy(asc(passkeyLoginChallenges.expiresAt))
        .limit(1);
      if (oldest.length > 0) {
        await tx
          .delete(passkeyLoginChallenges)
          .where(eq(passkeyLoginChallenges.id, oldest[0].id));
      }
    }
    await tx.insert(passkeyLoginChallenges).values({
      id,
      challenge,
      expiresAt,
    });
  });
  // The cookie only carries the row id — the challenge itself never
  // leaves the server.  /finish does the atomic consume so a captured
  // cookie + assertion pair is good for at most one request.
  await setSignedCookie(c, PASSKEY_LOGIN_COOKIE, id, SECRET_KEY, {
    httpOnly: true,
    secure: rpInfo.origin.startsWith("https://"),
    sameSite: "Strict",
    path: "/login/passkey",
    maxAge: PASSKEY_LOGIN_MAX_AGE_SECONDS,
  });
  return c.json(options);
});

const passkeyFinishSchema = z.object({
  next: z.string().optional(),
  authenticationResponse: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal("public-key"),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().optional(),
    response: z.object({
      clientDataJSON: z.string(),
      authenticatorData: z.string(),
      signature: z.string(),
      userHandle: z.string().optional(),
    }),
  }),
});

login.post("/passkey/finish", async (c) => {
  // Read the cookie and clear the browser-side copy up front, then
  // atomically consume the matching server-side row.  Whichever path
  // we leave on, the challenge can only be redeemed once.
  const cookieId = await getSignedCookie(c, SECRET_KEY, PASSKEY_LOGIN_COOKIE);
  deleteCookie(c, PASSKEY_LOGIN_COOKIE, { path: "/login/passkey" });
  if (cookieId == null || cookieId === false) {
    return c.json({ error: "Missing or invalid challenge cookie." }, 400);
  }
  // Atomically consume only an unexpired matching row.  An expired row
  // is left in place for the next /begin's GC to clean up, since a
  // captured cookie referring to an expired challenge has nothing to
  // gain by being deleted earlier than that.
  const consumed = await db
    .delete(passkeyLoginChallenges)
    .where(
      and(
        eq(passkeyLoginChallenges.id, cookieId),
        gte(passkeyLoginChallenges.expiresAt, new Date(Date.now())),
      ),
    )
    .returning({
      challenge: passkeyLoginChallenges.challenge,
    });
  if (consumed.length === 0) {
    return c.json(
      { error: "Challenge has already been used, expired, or never existed." },
      400,
    );
  }
  const { challenge } = consumed[0];

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const parsed = passkeyFinishSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body." }, 400);
  }
  const body = parsed.data;
  const credentialId = body.authenticationResponse.id;
  const storedPasskey = await db.query.passkeys.findFirst({
    where: eq(passkeys.id, credentialId),
  });
  if (storedPasskey == null) {
    return c.json({ error: "Unknown credential." }, 400);
  }

  const rpInfo = getRpInfo(c.req.url);
  const verified = await verifyAuthentication({
    rpInfo,
    // SimpleWebAuthn validates the wire shape; the Zod schema above
    // just rejects obviously wrong payloads.
    // oxlint-disable-next-line typescript/no-explicit-any
    response: body.authenticationResponse as any,
    expectedChallenge: challenge,
    storedPasskey,
  });
  if (verified == null) {
    return c.json({ error: "Authentication could not be verified." }, 400);
  }

  // Compare-and-set on the counter to defeat concurrent ceremonies that
  // verified against the same old value — if some other assertion already
  // advanced the row, this one loses and the caller is told to retry.
  const updated = await db
    .update(passkeys)
    .set({ counter: verified.newCounter, lastUsed: new Date() })
    .where(
      and(
        eq(passkeys.id, credentialId),
        eq(passkeys.counter, storedPasskey.counter),
      ),
    )
    .returning({ id: passkeys.id });
  if (updated.length === 0) {
    return c.json(
      { error: "Concurrent assertion detected; please retry." },
      409,
    );
  }

  const loginValue = new Date().toISOString();
  await setSignedCookie(c, "login", loginValue, SECRET_KEY);
  await setSignedCookie(c, "passkey", `${loginValue} passkey`, SECRET_KEY);
  return c.json({ redirect: safeNext(body.next, c.req.url) });
});

export default login;
