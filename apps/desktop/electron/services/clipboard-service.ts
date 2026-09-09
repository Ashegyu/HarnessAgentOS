import { APP_CLIPBOARD_WRITE_FAILED, err, harnessError, IPC_INVALID_PAYLOAD, ok, type HarnessResult } from "@harness/core";

// Keep renderer IPC bounded; never silently truncate an answer being copied.
export const MAX_CLIPBOARD_TEXT_LENGTH = 4 * 1024 * 1024;

export const copyAnswerText = (
  input: unknown,
  writeText: (text: string) => void,
  readText?: () => string,
): HarnessResult<void> => {
  const text = input && typeof input === "object" && !Array.isArray(input)
    ? (input as { text?: unknown }).text
    : undefined;
  if (
    typeof text !== "string" ||
    text.length > MAX_CLIPBOARD_TEXT_LENGTH ||
    text.trim().length === 0 ||
    text.includes("\0")
  ) {
    return err(harnessError(IPC_INVALID_PAYLOAD, "Expected non-empty text without NUL, up to 4,194,304 UTF-16 code units."));
  }
  try {
    writeText(text);
    // Electron can silently fail when the OS clipboard is locked. Do not
    // advertise success merely because writeText returned without throwing.
    if (readText && readText() !== text) throw new Error("Clipboard verification failed");
    return ok(undefined);
  } catch {
    // Neither the user's answer nor native clipboard errors belong in logs/IPC errors.
    return err(harnessError(APP_CLIPBOARD_WRITE_FAILED, "Could not copy the answer to the clipboard."));
  }
};

/** OS clipboard ownership can be temporarily busy. Retry only this explicit
 * copy request, with a 100 ms total delay cap, and verify every successful write. */
export const copyAnswerTextWithRetry = async (
  input: unknown,
  writeText: (text: string) => void,
  readText: () => string,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 50)),
): Promise<HarnessResult<void>> => {
  for (let attempt = 0; ; attempt++) {
    const result = copyAnswerText(input, writeText, readText);
    if (result.ok || result.error.code !== APP_CLIPBOARD_WRITE_FAILED || attempt === 2) return result;
    await wait();
  }
};
