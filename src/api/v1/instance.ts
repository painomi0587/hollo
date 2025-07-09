import { and, inArray, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import metadata from "../../../package.json" with { type: "json" };
import { db } from "../../db";
import { serializeAccountOwner } from "../../entities/account";
import { accountOwners, posts } from "../../schema";

const app = new Hono();

app.get("/", async (c) => {
  const url = new URL(c.req.url);
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    with: { account: { with: { successor: true } } },
    orderBy: accountOwners.id,
  });
  if (accountOwner == null) return c.notFound();
  const languages = await db
    .select({ language: posts.language })
    .from(posts)
    .where(
      and(
        isNotNull(posts.language),
        inArray(
          posts.accountId,
          db.select({ id: accountOwners.id }).from(accountOwners),
        ),
      ),
    )
    .groupBy(posts.language);
  return c.json({
    uri: url.host,
    title: url.host,
    short_description: `A Hollo instance at ${url.host}`,
    description: `A Hollo instance at ${url.host}`,
    email: credential.email,
    version: metadata.version,
    themeColor: "#f8dad1", // TODO
    urls: {}, // TODO
    stats: {
      user_count: 0, // TODO
      status_count: 0, // TODO
      domain_count: 0, // TODO
    },
    thumbnail: null, // TODO
    languages: languages.map(({ language }) => language),
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    configuration: {
      statuses: {
        // TODO
        max_characters: 10000,
        max_media_attachments: 8,
        characters_reserved_per_url: 256,
      },
      media_attachments: {
        supported_mime_types: [
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/webm",
        ],
        image_size_limit: 1024 * 1024 * 32, // 32MiB
        image_matrix_limit: 16_777_216,
        // TODO
        video_size_limit: 1024 * 1024 * 128, // 128MiB
        video_frame_rate_limit: 120,
        video_matrix_limit: 16_777_216,
      },
      polls: {
        max_options: 10,
        max_characters_per_option: 100,
        min_expiration: 60 * 5,
        max_expiration: 60 * 60 * 24 * 14,
      },
    },
    contact_account: serializeAccountOwner(accountOwner, c.req.url),
    rules: [],
    feature_quote: true,
    fedibird_capabilities: [
      "emoji_reaction",
      "enable_wide_emoji",
      "enable_wide_emoji_reaction",
    ],
  });
});

export default app;
