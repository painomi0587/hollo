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
import {
  accounts,
  instances,
  listMembers,
  lists,
  media,
  mentions,
  posts,
} from "../../schema";
import type { Uuid } from "../../uuid";
import { uuidv7 } from "../../uuid";

describe.sequential("/api/v1/timelines/list/:list_id", () => {
  let owner: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    owner = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:lists", "write"],
    });
    accessToken = await getAccessToken(client, owner, ["read:lists"]);
  });

  it("serializes mention URLs and attachment types compatibly for list timelines", async () => {
    expect.assertions(8);

    const listId = uuidv7();
    const authorId = crypto.randomUUID() as Uuid;
    const mentionedId = crypto.randomUUID() as Uuid;
    const postId = uuidv7();
    const mediaId = uuidv7();

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();

    await db.insert(lists).values({
      id: listId,
      accountOwnerId: owner.id,
      title: "Remote list",
      repliesPolicy: "list",
      exclusive: false,
    });

    await db.insert(accounts).values([
      {
        id: authorId,
        iri: "https://remote.test/users/author",
        instanceHost: "remote.test",
        type: "Person",
        name: "Remote author",
        emojis: {},
        handle: "@author@remote.test",
        bioHtml: "",
        url: "https://remote.test/@author",
        protected: false,
        inboxUrl: "https://remote.test/users/author/inbox",
      },
      {
        id: mentionedId,
        iri: "https://remote.test/users/mentioned",
        instanceHost: "remote.test",
        type: "Person",
        name: "Remote mentioned",
        emojis: {},
        handle: "@mentioned@remote.test",
        bioHtml: "",
        url: null,
        protected: false,
        inboxUrl: "https://remote.test/users/mentioned/inbox",
      },
    ]);

    await db.insert(listMembers).values({
      listId,
      accountId: authorId,
    });

    await db.insert(posts).values({
      id: postId,
      iri: `https://remote.test/notes/${postId}`,
      type: "Note",
      accountId: authorId,
      visibility: "public",
      content: "Post with mention and unsupported attachment",
      contentHtml: "<p>Post with mention and unsupported attachment</p>",
      published: new Date(),
    });

    await db.insert(mentions).values({
      postId,
      accountId: mentionedId,
    });

    await db.insert(media).values({
      id: mediaId,
      postId,
      type: "application/pdf",
      url: `https://remote.test/media/${mediaId}.pdf`,
      width: 640,
      height: 480,
      thumbnailType: "image/png",
      thumbnailUrl: `https://remote.test/media/${mediaId}.png`,
      thumbnailWidth: 320,
      thumbnailHeight: 240,
    });

    const response = await app.request(`/api/v1/timelines/list/${listId}`, {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].mentions[0].url).toBe("https://remote.test/users/mentioned");
    expect(json[0].mentions[0].acct).toBe("mentioned@remote.test");
    expect(json[0].media_attachments[0].type).toBe("unknown");
  });
});
