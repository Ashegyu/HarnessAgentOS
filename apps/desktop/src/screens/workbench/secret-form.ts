/**
 * Renderer-side form helpers for the secret vault editor. The actual
 * encryption + persistence lives in main process (SecretVaultService);
 * this module only validates user input before we send it across IPC.
 */

export interface SecretDraft {
  key: string;
  value: string;
}

export interface SecretDraftError {
  field: keyof SecretDraft;
  message: string;
}

export const emptySecretDraft = (): SecretDraft => ({ key: "", value: "" });

const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const validateSecretDraft = (
  draft: SecretDraft,
  existingKeys: readonly string[],
): SecretDraftError[] => {
  const errors: SecretDraftError[] = [];
  const key = draft.key.trim();
  if (key.length === 0) {
    errors.push({ field: "key", message: "키는 필수입니다" });
  } else if (!KEY_PATTERN.test(key)) {
    errors.push({
      field: "key",
      message: "키는 영문/숫자/._- 만 사용할 수 있습니다",
    });
  } else if (existingKeys.includes(key)) {
    errors.push({ field: "key", message: "이미 존재하는 키입니다" });
  }
  if (draft.value.length === 0) {
    errors.push({ field: "value", message: "값은 비워둘 수 없습니다" });
  }
  return errors;
};
