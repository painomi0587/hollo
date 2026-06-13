import { Temporal as PolyfillTemporal } from "@js-temporal/polyfill";

export function toTemporalInstant(value: Date): Temporal.Instant;
export function toTemporalInstant(value: null): null;
export function toTemporalInstant(value: Date | null): Temporal.Instant | null;
export function toTemporalInstant(value: Date | null): Temporal.Instant | null {
  // Fedify exposes ambient Temporal types, but Node 24 still needs the
  // polyfill value at runtime.
  return value == null
    ? null
    : (PolyfillTemporal.Instant.from(
        value.toISOString(),
      ) as unknown as Temporal.Instant);
}

export function toDate(value: Temporal.Instant): Date;
export function toDate(value: null): null;
export function toDate(value: Temporal.Instant | null): Date | null;
export function toDate(value: Temporal.Instant | null): Date | null {
  return value == null ? value : new Date(value.toString());
}
