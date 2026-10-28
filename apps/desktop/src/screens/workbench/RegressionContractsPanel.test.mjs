import {test} from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
globalThis.React=React;
const {RegressionContractsPanel}=await import("./RegressionContractsPanel.tsx");

test("regression registration explains positive controls and keeps consent explicit before execution approval",()=>{
  const html=renderToStaticMarkup(React.createElement(RegressionContractsPanel,{taskRunId:"t",revision:[],onChanged:async()=>{}}));
  assert.match(html,/정상 기준 구현 폴더/);
  assert.match(html,/Main 포함/);
  assert.match(html,/개별 실행 승인 후 호스트 권한/);
  assert.match(html,/<button type="submit" disabled="">기준·검사 등록<\/button>/);
  assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);
});
