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

// Syntax-level check only; we don't resolve DNS or contact the host.
// HANDLE_HOST is the bare hostname used in fediverse handles (the part
// after the second `@`), so it must not carry a scheme, port, or path.
if (rawHandleHost != null && rawHandleHost !== "") {
  if (rawHandleHost.includes("/") || rawHandleHost.includes(":")) {
    throw new Error(
      "HANDLE_HOST must be a bare hostname (e.g. example.com) with no scheme, port, or path.",
    );
  }
  // Use URL.canParse on a synthesized URL to catch other malformed
  // hostnames (whitespace, control characters, empty labels, etc.).
  // canParse is Unicode-aware, so IDN domains pass through.
  if (!URL.canParse(`https://${rawHandleHost}/`)) {
    throw new Error("HANDLE_HOST must be a valid hostname (e.g. example.com).");
  }
}

// Syntax-level checks only; we don't resolve DNS or contact the host.
// Fedify enforces the same shape when the origin is wired into
// createFederation, but checking up front gives the operator a clear
// error pointing at the env variable instead of a downstream TypeError.
let normalizedWebOrigin: string | undefined;
if (rawWebOrigin != null && rawWebOrigin !== "") {
  if (!URL.canParse(rawWebOrigin)) {
    throw new Error(
      "WEB_ORIGIN must be a valid URL (e.g. https://ap.example.com).",
    );
  }
  const webOriginUrl = new URL(rawWebOrigin);
  if (webOriginUrl.protocol !== "http:" && webOriginUrl.protocol !== "https:") {
    throw new Error(
      "WEB_ORIGIN must use the http or https scheme (e.g. https://ap.example.com).",
    );
  }
  if (
    (webOriginUrl.pathname !== "/" && webOriginUrl.pathname !== "") ||
    webOriginUrl.search !== "" ||
    webOriginUrl.hash !== ""
  ) {
    throw new Error(
      "WEB_ORIGIN must be a bare origin (scheme and host only) with no path, query string, or fragment.",
    );
  }
  // URL.origin yields the canonical form (lowercased host, no trailing
  // slash), so consumers can rely on a normalized value.
  normalizedWebOrigin = webOriginUrl.origin;
}

export const HANDLE_HOST = handleHostSet ? rawHandleHost : undefined;
export const WEB_ORIGIN = normalizedWebOrigin;
export const FEDIFY_ORIGIN =
  HANDLE_HOST != null && WEB_ORIGIN != null
    ? { handleHost: HANDLE_HOST, webOrigin: WEB_ORIGIN }
    : undefined;
