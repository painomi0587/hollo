import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../../tests/helpers";
import { createAccount } from "../../../tests/helpers/oauth";
import db from "../../db";
import { type PostVisibility, posts } from "../../schema";
import type { Uuid } from "../../uuid";
import profile from "./index";

const app = new Hono();

app.route("/:handle{@[^/]+}", profile);

async function createPost(
  accountId: string,
  visibility: PostVisibility,
  content: string,
) {
  const id = crypto.randomUUID() as Uuid;
  await db.insert(posts).values({
    id,
    iri: `https://hollo.test/@hollo/${id}`,
    type: "Note",
    accountId: accountId as Uuid,
    visibility,
    contentHtml: `<p>${content}</p>`,
    content,
    url: `https://hollo.test/@hollo/${id}`,
    published: new Date(),
  });
}

describe("Profile Atom feed", () => {
  let accountId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const account = await createAccount({ generateKeyPair: true });
    accountId = account.id;
  });

  it("only includes public and unlisted posts", async () => {
    expect.assertions(6);

    await createPost(accountId, "public", "public post");
    await createPost(accountId, "unlisted", "unlisted post");
    await createPost(accountId, "private", "followers-only post");
    await createPost(accountId, "direct", "secret DM");

    const response = await app.request("/@hollo/atom.xml");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/atom+xml",
    );

    const body = await response.text();
    expect(body).toContain("public post");
    expect(body).toContain("unlisted post");
    expect(body).not.toContain("followers-only post");
    expect(body).not.toContain("secret DM");
  });
});
