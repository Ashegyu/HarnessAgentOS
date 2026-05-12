import {
  SECRET_VAULT_UNAVAILABLE,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type HarnessResult,
} from "@harness/core";
import {
  SecretVaultService,
  SecretVaultUnavailableError,
} from "@harness/storage";

export interface SecretIpcContext {
  vault: SecretVaultService;
}

/**
 * Note the surface: `write`, `clear`, `listKeys`. **No `read`.**
 * The renderer never receives plaintext secrets — decryption happens
 * exclusively inside the main process at spawn time (Phase 4).
 * See docs/design/agent-detailed-settings.md §7.
 */
export const buildSecretHandlers = (ctx: SecretIpcContext) => {
  const { vault } = ctx;

  return {
    write: async (input: {
      key: string;
      value: string;
    }): Promise<HarnessResult<void>> => {
      if (typeof input?.key !== "string" || input.key.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "key must be non-empty"));
      }
      if (typeof input?.value !== "string") {
        return err(harnessError(STATE_INVALID_INPUT, "value must be a string"));
      }
      try {
        await vault.write(input.key, input.value);
        return ok(undefined);
      } catch (e) {
        if (e instanceof SecretVaultUnavailableError) {
          return err(harnessError(SECRET_VAULT_UNAVAILABLE, e.message));
        }
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(STATE_INVALID_INPUT, msg));
      }
    },

    clear: async (input: { key: string }): Promise<HarnessResult<void>> => {
      if (typeof input?.key !== "string" || input.key.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "key must be non-empty"));
      }
      try {
        await vault.clear(input.key);
        return ok(undefined);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(STATE_INVALID_INPUT, msg));
      }
    },

    listKeys: async (): Promise<HarnessResult<string[]>> => {
      try {
        return ok(await vault.listKeys());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(STATE_INVALID_INPUT, msg));
      }
    },
  };
};

export type SecretIpcHandlers = ReturnType<typeof buildSecretHandlers>;
