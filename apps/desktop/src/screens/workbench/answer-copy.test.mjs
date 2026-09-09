import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentStreamSections } from "./AgentStreamSections.tsx";
import { I18nProvider, translateUiKey } from "../../app/i18n.tsx";

globalThis.React = React;

const render = (props) => renderToStaticMarkup(createElement(I18nProvider, null,
  createElement(AgentStreamSections, { surface: "inline", terminal: true, ...props })));

test("model output is labelled as a response, not a completed operation", () => {
  const html = render({ sections: [{ id: "answer", kind: "final", text: "계획을 만들었습니다." }] });
  assert.match(html, /AI 답변/);
  assert.doesNotMatch(html, /최종 답변|✓/);
});

for (const surface of ["inline", "panel"]) {
  test(`${surface} final answers expose an accessible copy button`, () => {
    const html = render({ surface, sections: [{ id: "answer", kind: "final", text: "한글 답변\n\n```ts\nconst n = 1;\n```" }] });
    assert.match(html, /aria-label="답변 복사"/);
    assert.match(html, /type="button"/);
  });
}

test("saved fallback answers can be copied too", () => {
  assert.match(render({ sections: [], fallbackFinalText: "이전 답변" }), /aria-label="답변 복사"/);
});

test("intermediate responses expose copy without copying thinking or tool output", () => {
  const html = render({ terminal: false, sections: [
    { id: "thinking", kind: "thinking", text: "내부 진행" },
    { id: "response", kind: "response", phase: "live", text: "현재 작성된 답변" },
  ] });
  assert.equal((html.match(/aria-label="답변 복사"/g) ?? []).length, 1);
});

test("empty or thinking-only output has no answer-copy button", () => {
  for (const sections of [[], [{ id: "empty", kind: "final", text: " \n" }], [{ id: "thinking", kind: "thinking", text: "진행" }]]) {
    assert.doesNotMatch(render({ sections }), /aria-label="답변 복사"/);
  }
});

test("copy feedback is translated in both languages", () => {
  for (const [key, ko, en] of [
    ["answer.copy", "답변 복사", "Copy answer"],
    ["answer.copied", "복사됨", "Copied"],
    ["answer.copying", "복사 중…", "Copying…"],
    ["answer.copyFailed", "복사하지 못했습니다. 다시 시도하거나 답변을 선택해 Ctrl+C로 복사하세요.", "Could not copy. Try again or select the answer and press Ctrl+C."],
  ]) {
    assert.equal(translateUiKey(key, "ko"), ko);
    assert.equal(translateUiKey(key, "en"), en);
  }
});
