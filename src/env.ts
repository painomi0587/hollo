const SECRET_KEY_MINIMUM_LENGTH = 44;

// oxlint-disable-next-line typescript/dot-notation
const secretKey = process.env["SECRET_KEY"];

if (typeof secretKey !== "string") {
  throw new Error("SECRET_KEY is required");
}

if (secretKey.length < SECRET_KEY_MINIMUM_LENGTH) {
  throw new Error(
    `SECRET_KEY is too short, received: ${secretKey.length}, expected: ${SECRET_KEY_MINIMUM_LENGTH}`,
  );
}

export const SECRET_KEY = secretKey;

// oxlint-disable-next-line typescript/dot-notation
const rawHandleHost = process.env["HANDLE_HOST"]?.trim().toLowerCase();
// oxlint-disable-next-line typescript/dot-notation
const rawWebOrigin = process.env["WEB_ORIGIN"]?.trim().replace(/\/+$/, "");

const handleHostSet = rawHandleHost != null && rawHandleHost !== "";
const webOriginSet = rawWebOrigin != null && rawWebOrigin !== "";

if (handleHostSet !== webOriginSet) {
  throw new Error(
    "HANDLE_HOST and WEB_ORIGIN must be set together (or both unset).",
  );
}

// Syntax check only; Fedify enforces the stricter shape (http/https scheme,
// no path/query/fragment) when the origin is wired into createFederation.
if (
  rawWebOrigin != null &&
  rawWebOrigin !== "" &&
  !URL.canParse(rawWebOrigin)
) {
  throw new Error(
    "WEB_ORIGIN must be a valid URL (e.g. https://ap.example.com).",
  );
}

export const HANDLE_HOST = handleHostSet ? rawHandleHost : undefined;
export const WEB_ORIGIN = webOriginSet ? rawWebOrigin : undefined;
export const FEDIFY_ORIGIN =
  HANDLE_HOST != null && WEB_ORIGIN != null
    ? { handleHost: HANDLE_HOST, webOrigin: WEB_ORIGIN }
    : undefined;
