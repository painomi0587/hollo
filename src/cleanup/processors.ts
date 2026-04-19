import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";

import db from "../db";
import * as schema from "../schema";
import { drive } from "../storage";
import { STORAGE_URL_BASE } from "../storage-config";
import type { Uuid } from "../uuid";

const logger = getLogger(["hollo", "cleanup-processors"]);

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
    logger.error("medium missing in database: {id}", { id: data.id });
    throw new Error(`medium missing in database: ${data.id}`);
  }

  if (!medium.thumbnailUrl.startsWith(STORAGE_URL_BASE as string)) {
    logger.error(
      "The thumbnail URL {thumbnailUrl} does not match the storage URL pattern {storageUrlBase}!",
      {
        thumbnailUrl: medium.thumbnailUrl,
        STORAGE_URL_BASE,
      },
    );
    throw new Error(
      `The thumbnail URL ${medium.thumbnailUrl} does not match the storage URL pattern ${STORAGE_URL_BASE}!`,
    );
  }

  const key = medium.thumbnailUrl.replace(STORAGE_URL_BASE as string, "");

  const disk = drive.use();
  await disk.delete(key);
  await db
    .update(schema.media)
    .set({ thumbnailCleaned: true })
    .where(eq(schema.media.id, medium.id));
}
