import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import webpush from "web-push";

import { db } from "./db";
import { vapidKeys } from "./schema";

const logger = getLogger(["hollo", "vapid"]);

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export async function getVapidPublicKey(): Promise<string> {
  const details = await getVapidDetails();
  return details.publicKey;
}

export async function getVapidDetails(subject?: string): Promise<VapidDetails> {
  const existing = await db.query.vapidKeys.findFirst();

  if (existing != null) {
    const effectiveSubject = subject ?? existing.subject;
    if (subject != null && subject !== existing.subject) {
      await db
        .update(vapidKeys)
        .set({ subject })
        .where(eq(vapidKeys.id, existing.id));
    }
    return {
      subject: effectiveSubject,
      publicKey: existing.publicKey,
      privateKey: existing.privateKey,
    };
  }

  const keys = webpush.generateVAPIDKeys();
  const effectiveSubject = subject ?? "https://localhost";

  await db
    .insert(vapidKeys)
    .values({
      id: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      subject: effectiveSubject,
    })
    .onConflictDoUpdate({
      target: vapidKeys.id,
      set: { subject: effectiveSubject },
    });

  logger.info("Generated new VAPID key pair with subject {subject}", {
    subject: effectiveSubject,
  });

  return {
    subject: effectiveSubject,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}
