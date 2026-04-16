import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hollo", "storage"]);

export type DriveDisk = "fs" | "s3";

if (
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["FS_ASSET_PATH"] !== undefined &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["FS_STORAGE_PATH"] === undefined
) {
  logger.warn("FS_ASSET_PATH is deprecated; use FS_STORAGE_PATH instead.");
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["FS_STORAGE_PATH"] = process.env["FS_ASSET_PATH"];
}

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
export const FS_STORAGE_PATH = process.env["FS_STORAGE_PATH"];

let driveDisk: DriveDisk;

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const driveDiskEnv = process.env["DRIVE_DISK"];
if (driveDiskEnv === undefined) {
  logger.warn(
    "DRIVE_DISK is not configured; defaults to 's3'.  " +
      "The DRIVE_DISK environment variable will be mandatory in the future versions.",
  );
  driveDisk = "s3";
} else if (driveDiskEnv.toLowerCase() === "s3") {
  driveDisk = "s3";
} else if (driveDiskEnv.toLowerCase() === "fs") {
  driveDisk = "fs";
} else {
  throw new Error(`Unknown DRIVE_DISK value: '${driveDiskEnv}'`);
}

export const DRIVE_DISK: DriveDisk = driveDisk;

if (
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["ASSET_URL_BASE"] !== undefined &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] === undefined
) {
  logger.warn("ASSET_URL_BASE is deprecated; use STORAGE_URL_BASE instead.");
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] = process.env["ASSET_URL_BASE"];
}

if (
  driveDisk === "s3" &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["S3_URL_BASE"] !== undefined &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] === undefined
) {
  logger.warn("S3_URL_BASE is deprecated; use STORAGE_URL_BASE instead.");
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] = process.env["S3_URL_BASE"];
}

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
export const STORAGE_URL_BASE = process.env["STORAGE_URL_BASE"];

if (!STORAGE_URL_BASE) {
  throw new Error("STORAGE_URL_BASE is required");
}
