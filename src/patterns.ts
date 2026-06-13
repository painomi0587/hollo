/**
 * Regular expression pattern for matching WebFinger handles.
 *
 * Matches formats like:
 * - `@user@domain.tld`
 * - `user@domain.tld`
 *
 * Note: This pattern uses the `u` flag for Unicode support, but NOT the `g`
 * flag to avoid issues with `test()` being stateful on global regexes.
 */
export const HANDLE_PATTERN =
  /^@?[\p{L}\p{N}._-]+@(?:[\p{L}\p{N}][\p{L}\p{N}_-]*\.)+[\p{L}\p{N}]{2,}$/u;

/**
 * Strip a single leading `@` from a handle-like value.
 *
 * Use this on values that came from user input before further parsing: many
 * fediverse clients send handles in the user-typed `@user@domain` form, but
 * Hollo's lookup paths build their own leading `@`, which would otherwise
 * produce `@@user@domain` and miss every stored handle.
 */
export function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "");
}
