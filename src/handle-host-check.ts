import { getLogger } from "@logtape/logtape";

import { db } from "./db";
import { HANDLE_HOST } from "./env";

const logger = getLogger(["hollo", "config"]);

export async function checkHandleHostConsistency(): Promise<void> {
  if (HANDLE_HOST == null) return;
  const owners = await db.query.accountOwners.findMany({
    with: { account: { columns: { handle: true } } },
  });
  for (const owner of owners) {
    const handle = owner.account.handle;
    const at = handle.lastIndexOf("@");
    if (at < 0) continue;
    const existingHost = handle.slice(at + 1).toLowerCase();
    if (existingHost === HANDLE_HOST) continue;
    logger.warn(
      "Configured HANDLE_HOST ({configured}) does not match existing " +
        "account handle host ({existing}) for {handle}. Changing the " +
        "handle domain after federation has begun breaks remote follow " +
        "relationships. See https://docs.hollo.social/install/split-domain/",
      { configured: HANDLE_HOST, existing: existingHost, handle },
    );
  }
}
