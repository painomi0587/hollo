import { eq } from "drizzle-orm";

import db from "../db";
import * as schema from "../schema";
import { drive } from "../storage";
import { STORAGE_URL_BASE } from "../storage-config";
import type { Uuid } from "../uuid";

// Type for thumbnail cleanup item data
interface ThumbnailCleanupItemData {
  id: Uuid;
}

export async function processThumbnailDeletion(
  item: schema.CleanupJobItem,
): Promise<void> {
  const data = item.data as unknown as ThumbnailCleanupItemData;

  const medium = await db.query.media.findFirst({
    where: eq(schema.media.id, data.id),
  });

  if (medium == null) {
    throw new Error(`medium missing in database: ${data.id}`);
  }

  if (STORAGE_URL_BASE == null) {
    throw new Error("storage url is not configured");
  }

  const key = medium.thumbnailUrl.split("/").slice(-3).join("/");

  const reconstructedUrl = new URL(
    key,
    STORAGE_URL_BASE + (STORAGE_URL_BASE.endsWith("/") ? "" : "/"),
  ).toString();

  if (reconstructedUrl !== medium.thumbnailUrl) {
    if (!medium.thumbnailUrl.startsWith(STORAGE_URL_BASE)) {
      throw new Error(
        "The thumbnail URL ${thumbnailUrl} does not match the storage URL pattern ${storageUrlBase}!",
      );
    } else {
      throw new Error("The thumbnail URL ${medium.thumbnailUrl} is malformed.");
    }
  }

  const disk = drive.use();
  await disk.delete(key);
  await db
    .update(schema.media)
    .set({ thumbnailCleaned: true })
    .where(eq(schema.media.id, medium.id));
}
