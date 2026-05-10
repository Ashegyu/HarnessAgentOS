import type { HarnessError } from "./error";

export type HarnessResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessError };

export const ok = <T>(value: T): HarnessResult<T> => ({ ok: true, value });

export const err = <T = never>(error: HarnessError): HarnessResult<T> => ({
  ok: false,
  error,
});

export const isOk = <T>(
  r: HarnessResult<T>,
): r is { ok: true; value: T } => r.ok;

export const isErr = <T>(
  r: HarnessResult<T>,
): r is { ok: false; error: HarnessError } => !r.ok;

export const unwrap = <T>(r: HarnessResult<T>): T => {
  if (r.ok) return r.value;
  const e = new Error(`[${r.error.code}] ${r.error.message}`);
  (e as Error & { harnessError: HarnessError }).harnessError = r.error;
  throw e;
};
