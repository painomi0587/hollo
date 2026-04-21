import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hollo", "storage"]);

export type DriveDisk = "fs" | "s3";

if (
  // oxlint-disable-next-line typescript/dot-notation
  process.env["FS_ASSET_PATH"] !== undefined &&
  // oxlint-disable-next-line typescript/dot-notation
  process.env["FS_STORAGE_PATH"] === undefined
) {
  logger.warn("FS_ASSET_PATH is deprecated; use FS_STORAGE_PATH instead.");
  // oxlint-disable-next-line typescript/dot-notation
  process.env["FS_STORAGE_PATH"] = process.env["FS_ASSET_PATH"];
}

// oxlint-disable-next-line typescript/dot-notation
export const FS_STORAGE_PATH = process.env["FS_STORAGE_PATH"];

let driveDisk: DriveDisk;

// oxlint-disable-next-line typescript/dot-notation
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
  // oxlint-disable-next-line typescript/dot-notation
  process.env["ASSET_URL_BASE"] !== undefined &&
  // oxlint-disable-next-line typescript/dot-notation
  process.env["STORAGE_URL_BASE"] === undefined
) {
  logger.warn("ASSET_URL_BASE is deprecated; use STORAGE_URL_BASE instead.");
  // oxlint-disable-next-line typescript/dot-notation
  process.env["STORAGE_URL_BASE"] = process.env["ASSET_URL_BASE"];
}

if (
  driveDisk === "s3" &&
  // oxlint-disable-next-line typescript/dot-notation
  process.env["S3_URL_BASE"] !== undefined &&
  // oxlint-disable-next-line typescript/dot-notation
  process.env["STORAGE_URL_BASE"] === undefined
) {
  logger.warn("S3_URL_BASE is deprecated; use STORAGE_URL_BASE instead.");
  // oxlint-disable-next-line typescript/dot-notation
  process.env["STORAGE_URL_BASE"] = process.env["S3_URL_BASE"];
}

// oxlint-disable-next-line typescript/dot-notation
export const STORAGE_URL_BASE = process.env["STORAGE_URL_BASE"];

if (!STORAGE_URL_BASE) {
  throw new Error("STORAGE_URL_BASE is required");
}
