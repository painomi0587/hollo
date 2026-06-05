import { getSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import { db } from "./db";
import { SECRET_KEY } from "./env";

export const loginRequired = createMiddleware(async (c, next) => {
  const login = await getSignedCookie(c, SECRET_KEY, "login");
  if (login == null || login === false) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`);
  }
  const totp = await db.query.totps.findFirst();
  if (totp != null) {
    // Either a TOTP code challenge or a passkey assertion bound to the
    // same login session satisfies the second factor.  A passkey is
    // already multi-factor on its own (something the user has plus a
    // user-verification gesture), so it stands in for TOTP rather than
    // stacking on top of it.
    const otp = await getSignedCookie(c, SECRET_KEY, "otp");
    const passkey = await getSignedCookie(c, SECRET_KEY, "passkey");
    const otpOk = otp != null && otp !== false && otp === `${login} totp`;
    const passkeyOk =
      passkey != null && passkey !== false && passkey === `${login} passkey`;
    if (!otpOk && !passkeyOk) {
      return c.redirect(`/login/otp?next=${encodeURIComponent(c.req.url)}`);
    }
  }
  await next();
});
