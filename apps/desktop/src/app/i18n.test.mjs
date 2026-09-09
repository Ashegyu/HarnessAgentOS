import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLocale,
  translatedUiAttributes,
  translateUiKey,
  translateUiText,
  translateUiAttribute,
} from "./i18n.tsx";

test("normalizeLocale defaults invalid values to Korean", () => {
  assert.equal(normalizeLocale(undefined), "ko");
  assert.equal(normalizeLocale("fr"), "ko");
  assert.equal(normalizeLocale("en"), "en");
});

test("closure and preflight recovery messages switch language", () => {
  assert.equal(translateUiText("모델 실행이 차단되었습니다. 자동으로 재시도하지 않습니다.", "en"), "Model execution is blocked. It will not retry automatically.");
  assert.equal(translateUiText("응답 검증", "en"), "Response validation");
  assert.equal(translateUiText("읽기 전용 요청에서 변경 근거가 발견되었습니다.", "en"), "Change evidence was found in a read-only task.");
  assert.equal(translateUiText("성공한 최신 모델 호출에 연결된 최종 응답 근거가 없습니다.", "en"), "No final response evidence is linked to the latest successful model invocation.");
});

test("budget warning explains unknown billing in both languages", () => {
  const ko = "비워두면 USD 제한을 적용하지 않습니다. 한도를 설정하면 비용 미확인 호출은 실행 전에 차단됩니다. 현재 CLI의 과금 방식과 호출 전 비용은 미확인입니다.";
  const en = "Leave blank for no USD cap. With a cap, calls with unknown cost are blocked before execution. CLI billing mode and pre-call cost are currently unverified.";
  assert.equal(translateUiText(ko, "en"), en);
  assert.equal(translateUiText(en, "ko"), ko);
});

test("translateUiText switches common UI and built-in catalog labels both ways", () => {
  assert.equal(translateUiText("Remote Agents", "ko"), "원격 에이전트");
  assert.equal(translateUiText("Code Review Agent", "ko"), "코드 리뷰 에이전트");
  assert.equal(translateUiText("코드 리뷰 에이전트", "en"), "Code Review Agent");
  assert.equal(translateUiText("Settings", "ko"), "설정");
  assert.equal(
    translateUiText(
      "Astra는 가장 복잡한 작업, Sol은 고성능, Terra는 균형형, Luna는 빠르고 경제적인 실행에 적합합니다.",
      "en",
    ),
    "Astra is for the hardest tasks, Sol for high performance, Terra for balance, and Luna for fast, economical runs.",
  );
});

test("translateUiText preserves code, paths, URLs, and unknown user content", () => {
  assert.equal(translateUiText("http://127.0.0.1:7411", "ko"), "http://127.0.0.1:7411");
  assert.equal(translateUiText("C:\\workspace\\app.ts", "ko"), "C:\\workspace\\app.ts");
  assert.equal(translateUiText("my custom request", "ko"), "my custom request");
});

test("translateUiAttribute localizes known placeholders and labels", () => {
  assert.equal(translateUiAttribute("Search commands...", "ko"), "명령 검색...");
  assert.equal(translateUiAttribute("Close", "ko"), "닫기");
});

test("translateUiKey resolves stable semantic keys in both languages", () => {
  assert.equal(translateUiKey("settings.parallelWorkers", "ko"), "최대 병렬 AI 작업 수");
  assert.equal(translateUiKey("settings.parallelWorkers", "en"), "Maximum parallel AI workers");
  assert.equal(translateUiKey("parallel.running", "ko", { running: 2, total: 3 }), "병렬 실행 중 2/3");
  assert.equal(translateUiKey("parallel.running", "en", { running: 2, total: 3 }), "Running in parallel 2/3");
});

test("accessibility labels participate in locale switching", () => {
  assert.ok(translatedUiAttributes.includes("aria-label"));
});
