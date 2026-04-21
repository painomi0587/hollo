import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
  getClientCredentialToken,
} from "../../../tests/helpers/oauth";
import db from "../../db";
import app from "../../index";
import { accountOwners, accounts } from "../../schema";

describe.sequential("/api/v1/preferences", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:accounts"],
      confidential: true,
    });
  });

  it("returns the authenticated account preferences", async () => {
    expect.assertions(4);

    await db
      .update(accounts)
      .set({ sensitive: true })
      .where(eq(accounts.id, account.id));
    await db
      .update(accountOwners)
      .set({
        visibility: "private",
        language: "ko",
        expandSpoilers: true,
      })
      .where(eq(accountOwners.id, account.id));

    const accessToken = await getAccessToken(client, account, [
      "read:accounts",
    ]);
    const response = await app.request("/api/v1/preferences", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const preferences = await response.json();

    expect(preferences).toEqual({
      "posting:default:visibility": "private",
      "posting:default:sensitive": true,
      "posting:default:language": "ko",
      "reading:expand:media": "default",
      "reading:expand:spoilers": true,
    });
  });

  it("defaults content warnings to collapsed", async () => {
    expect.assertions(2);

    const accessToken = await getAccessToken(client, account, [
      "read:accounts",
    ]);
    const response = await app.request("/api/v1/preferences", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });
    const preferences = await response.json();

    expect(response.status).toBe(200);
    expect(preferences["reading:expand:spoilers"]).toBe(false);
  });

  it("rejects client-credential tokens without an authenticated user", async () => {
    expect.assertions(4);

    const clientCredential = await getClientCredentialToken(client, [
      "read:accounts",
    ]);
    const response = await app.request("/api/v1/preferences", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(clientCredential),
      },
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      error: "This method requires an authenticated user",
    });
  });
});
