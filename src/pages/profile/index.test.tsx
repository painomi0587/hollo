import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import { createAccount } from "../../../tests/helpers/oauth";
import db from "../../db";
import { featuredTags, posts } from "../../schema";
import { uuidv7 } from "../../uuid";
import app from "../index";

describe.sequential("profile tagged page", () => {
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();
    account = await createAccount();
  });

  it("shows only the profile user's matching tagged posts", async () => {
    expect.assertions(5);

    const taggedPostId = uuidv7();
    const otherPostId = uuidv7();
    const privateTaggedPostId = uuidv7();

    await db.insert(posts).values([
      {
        id: taggedPostId,
        iri: `https://hollo.test/@hollo/${taggedPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Matching profile tag post",
        contentHtml: "<p>Matching profile tag post</p>",
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
        content: "Different tag post",
        contentHtml: "<p>Different tag post</p>",
        tags: {
          "#othertag": "https://hollo.test/tags/OtherTag",
        },
        published: new Date(),
      },
      {
        id: privateTaggedPostId,
        iri: `https://hollo.test/@hollo/${privateTaggedPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "private",
        content: "Private matching tag post",
        contentHtml: "<p>Private matching tag post</p>",
        tags: {
          "#testtag": "https://hollo.test/tags/TestTag",
        },
        published: new Date(),
      },
    ]);

    const response = await app.request("/@hollo/tagged/TestTag");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("Posts tagged #TestTag");
    expect(html).toContain("Matching profile tag post");
    expect(html).not.toContain("Different tag post");
    expect(html).not.toContain("Private matching tag post");
  });

  it("links featured tags to the profile-specific tagged page", async () => {
    expect.assertions(2);

    await db.insert(featuredTags).values({
      id: uuidv7(),
      accountOwnerId: account.id,
      name: "TestTag",
      created: new Date(),
    });

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/@hollo/tagged/TestTag"');
  });
});
