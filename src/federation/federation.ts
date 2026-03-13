import { createFederation, ParallelMessageQueue } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import metadata from "../../package.json" with { type: "json" };
import { postgres } from "../db";

export const federation = createFederation<void>({
  kv: new PostgresKvStore(postgres),
  queue: new ParallelMessageQueue(new PostgresMessageQueue(postgres), 10),
  // TODO: Revert to Fedify's default RFC 9421-first behavior once
  // https://github.com/bonfire-networks/activity_pub/issues/8 is fixed and
  // released.
  firstKnock: "draft-cavage-http-signatures-12",
  userAgent: {
    software: `Hollo/${metadata.version}`,
  },
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  allowPrivateAddress: process.env["ALLOW_PRIVATE_ADDRESS"] === "true",
});

export default federation;
