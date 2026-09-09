import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineApprovalCard } from "./InlineApprovalCard.tsx";
globalThis.React = React;

test("manual approval remains actionable when automatic approval is enabled", () => {
  const html = renderToStaticMarkup(React.createElement(InlineApprovalCard, {
    approvals: [{ id: "a", status: "pending", actionType: "shell", requiresManualApproval: true }],
    autoApprove: true, contextDrawerOpen: false, onOpenDrawer: () => {},
  }));
  assert.match(html, /승인 패널 열기/);
  assert.doesNotMatch(html, /자동 승인 처리 중/);
});
