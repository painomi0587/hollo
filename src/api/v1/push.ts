import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";

import { db } from "../../db";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { type WebPushSubscription, webPushSubscriptions } from "../../schema";
import { uuidv7 } from "../../uuid";
import { getVapidDetails, getVapidPublicKey } from "../../vapid";

const logger = getLogger(["hollo", "api", "v1", "push"]);

const app = new Hono<{ Variables: Variables }>();

function parseBracketNotation(
  data: Record<string, string | File>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    const parts = key.replace(/\]/g, "").split("[");
    let current: Record<string, unknown> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof current[part] !== "object" || current[part] == null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

function toBoolean(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function serializeSubscription(
  sub: WebPushSubscription,
  serverKey: string,
): object {
  return {
    id: sub.id,
    endpoint: sub.endpoint,
    standard: "legacy",
    alerts: {
      follow: sub.followAlerts,
      favourite: sub.favouriteAlerts,
      reblog: sub.reblogAlerts,
      mention: sub.mentionAlerts,
      poll: sub.pollAlerts,
      status: sub.statusAlerts,
      follow_request: sub.followRequestAlerts,
      update: sub.updateAlerts,
      "admin.sign_up": false,
      "admin.report": false,
    },
    server_key: serverKey,
  };
}

// oxlint-disable-next-line typescript/no-explicit-any
async function parseBody(c: Context<any>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type")?.toLowerCase();
  if (contentType?.startsWith("application/json")) {
    return await c.req.json();
  }
  const formData = await c.req.parseBody();
  return parseBracketNotation(formData as Record<string, string | File>);
}

app.get("/", tokenRequired, scopeRequired(["push"]), async (c) => {
  const token = c.get("token");
  const subscription = await db.query.webPushSubscriptions.findFirst({
    where: { accessTokenCode: { eq: token.code } },
  });

  if (subscription == null) {
    return c.json({ error: "Record not found" }, 404);
  }

  const serverKey = await getVapidPublicKey();
  return c.json(serializeSubscription(subscription, serverKey));
});

app.post("/", tokenRequired, scopeRequired(["push"]), async (c) => {
  const token = c.get("token");
  if (token.accountOwnerId == null) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await parseBody(c);
  const subscriptionData = body.subscription as
    | Record<string, unknown>
    | undefined;
  const dataBlock = body.data as Record<string, unknown> | undefined;
  const alertData = dataBlock?.alerts as Record<string, unknown> | undefined;
  const policy = dataBlock?.policy as string | undefined;

  const endpoint = subscriptionData?.endpoint as string | undefined;
  const keys = subscriptionData?.keys as Record<string, unknown> | undefined;
  const p256dh = keys?.p256dh as string | undefined;
  const auth = keys?.auth as string | undefined;

  if (endpoint == null || p256dh == null || auth == null) {
    return c.json({ error: "Missing required subscription fields" }, 422);
  }

  const origin = new URL(c.req.url).origin;

  await db
    .delete(webPushSubscriptions)
    .where(eq(webPushSubscriptions.accessTokenCode, token.code));

  const [subscription] = await db
    .insert(webPushSubscriptions)
    .values({
      id: uuidv7(),
      accessTokenCode: token.code,
      accountOwnerId: token.accountOwnerId,
      endpoint,
      p256dhKey: p256dh,
      authKey: auth,
      followAlerts: toBoolean(alertData?.follow),
      favouriteAlerts: toBoolean(alertData?.favourite),
      reblogAlerts: toBoolean(alertData?.reblog),
      mentionAlerts: toBoolean(alertData?.mention),
      pollAlerts: toBoolean(alertData?.poll),
      statusAlerts: toBoolean(alertData?.status),
      followRequestAlerts: toBoolean(alertData?.follow_request),
      updateAlerts: toBoolean(alertData?.update),
      policy: policy ?? "all",
    })
    .returning();

  const vapid = await getVapidDetails(origin);

  logger.debug("Created push subscription for token {code}", {
    code: token.code,
  });

  return c.json(serializeSubscription(subscription, vapid.publicKey));
});

app.put("/", tokenRequired, scopeRequired(["push"]), async (c) => {
  const token = c.get("token");

  const existing = await db.query.webPushSubscriptions.findFirst({
    where: { accessTokenCode: { eq: token.code } },
  });

  if (existing == null) {
    return c.json({ error: "Record not found" }, 404);
  }

  const body = await parseBody(c);
  const dataBlock = body.data as Record<string, unknown> | undefined;
  const alertData = dataBlock?.alerts as Record<string, unknown> | undefined;
  const policy = dataBlock?.policy as string | undefined;

  const [updated] = await db
    .update(webPushSubscriptions)
    .set({
      followAlerts:
        alertData?.follow != null
          ? toBoolean(alertData.follow)
          : existing.followAlerts,
      favouriteAlerts:
        alertData?.favourite != null
          ? toBoolean(alertData.favourite)
          : existing.favouriteAlerts,
      reblogAlerts:
        alertData?.reblog != null
          ? toBoolean(alertData.reblog)
          : existing.reblogAlerts,
      mentionAlerts:
        alertData?.mention != null
          ? toBoolean(alertData.mention)
          : existing.mentionAlerts,
      pollAlerts:
        alertData?.poll != null
          ? toBoolean(alertData.poll)
          : existing.pollAlerts,
      statusAlerts:
        alertData?.status != null
          ? toBoolean(alertData.status)
          : existing.statusAlerts,
      followRequestAlerts:
        alertData?.follow_request != null
          ? toBoolean(alertData.follow_request)
          : existing.followRequestAlerts,
      updateAlerts:
        alertData?.update != null
          ? toBoolean(alertData.update)
          : existing.updateAlerts,
      policy: policy ?? existing.policy,
    })
    .where(eq(webPushSubscriptions.id, existing.id))
    .returning();

  const serverKey = await getVapidPublicKey();
  return c.json(serializeSubscription(updated, serverKey));
});

app.delete("/", tokenRequired, scopeRequired(["push"]), async (c) => {
  const token = c.get("token");
  await db
    .delete(webPushSubscriptions)
    .where(eq(webPushSubscriptions.accessTokenCode, token.code));
  return c.json({});
});

export default app;
