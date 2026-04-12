import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";

import db from "../../db";
import app from "../../index";
import { posts } from "../../schema";
import { uuidv7 } from "../../uuid";

describe.sequential("/api/v1/accounts/verify_credentials", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:accounts", "write", "profile"],
    });
  });

  it("Successfully returns the current accounts profile with a valid access token", async () => {
    expect.assertions(7);

    const accessToken = await getAccessToken(client, account, [
      "read:accounts",
    ]);

    const response = await app.request("/api/v1/accounts/verify_credentials", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const credentialAccount = await response.json();

    expect(typeof credentialAccount).toBe("object");
    expect(credentialAccount.id).toBe(account.id);
    expect(credentialAccount.username).toBe("hollo");
    expect(credentialAccount.acct).toBe("hollo@hollo.test");
  });

  it("Successfully returns the current accounts profile with an access token using profile scope", async () => {
    expect.assertions(7);

    const accessToken = await getAccessToken(client, account, ["profile"]);

    const response = await app.request("/api/v1/accounts/verify_credentials", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const credentialAccount = await response.json();

    expect(typeof credentialAccount).toBe("object");
    expect(credentialAccount.id).toBe(account.id);
    expect(credentialAccount.username).toBe("hollo");
    expect(credentialAccount.acct).toBe("hollo@hollo.test");
  });

  it("does not return the account when an invalid scope is used", async () => {
    expect.assertions(4);

    const accessToken = await getAccessToken(client, account, ["write"]);

    const response = await app.request("/api/v1/accounts/verify_credentials", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const error = await response.json();

    expect(error).toMatchObject({
      error: "insufficient_scope",
    });
  });

  it("does not return the account when no access token is used", async () => {
    expect.assertions(4);

    const response = await app.request("/api/v1/accounts/verify_credentials", {
      method: "GET",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const error = await response.json();

    expect(error).toMatchObject({
      error: "unauthorized",
    });
  });
});

describe.sequential("/api/v1/accounts/:id/statuses", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:statuses", "write"],
    });
  });

  it("filters statuses by the tagged query parameter", async () => {
    expect.assertions(6);

    const accessToken = await getAccessToken(client, account, [
      "read:statuses",
    ]);
    const matchingPostId = uuidv7();
    const otherPostId = uuidv7();

    await db.insert(posts).values([
      {
        id: matchingPostId,
        iri: `https://hollo.test/@hollo/${matchingPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Tagged status",
        contentHtml: "<p>Tagged status</p>",
        tags: {
          "#testtag": "https://hollo.test/tags/TestTag",
        },
        published: new Date(),
      },
      {
        id: otherPostId,
        iri: `https://hollo.test/@hollo/${otherPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Other status",
        contentHtml: "<p>Other status</p>",
        tags: {
          "#somethingelse": "https://hollo.test/tags/SomethingElse",
        },
        published: new Date(),
      },
    ]);

    const response = await app.request(
      `/api/v1/accounts/${account.id}/statuses?tagged=TestTag`,
      {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();

    expect(json).toHaveLength(1);
    expect(json[0].id).toBe(matchingPostId);
    expect(json[0].tags[0].name).toBe("testtag");
  });
});
