import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownInline, parseMarkdownLite } from "./markdown-lite.ts";

test("parses markdown headings, paragraphs, lists, and fenced code", () => {
  assert.deepEqual(
    parseMarkdownLite(
      [
        "## 결과",
        "",
        "요약 **강조** 문장입니다.",
        "",
        "- 첫째",
        "- 둘째",
        "",
        "```ts",
        "const ok = true;",
        "```",
      ].join("\n"),
    ),
    [
      { kind: "heading", depth: 2, text: "결과" },
      { kind: "paragraph", text: "요약 **강조** 문장입니다." },
      { kind: "ul", items: ["첫째", "둘째"] },
      { kind: "code", language: "ts", text: "const ok = true;" },
    ],
  );
});

test("parses ordered lists, blockquotes, and tables", () => {
  assert.deepEqual(
    parseMarkdownLite(
      [
        "> 참고",
        "> 계속",
        "",
        "1. one",
        "2. two",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    ),
    [
      {
        kind: "blockquote",
        blocks: [{ kind: "paragraph", text: "참고 계속" }],
      },
      { kind: "ol", items: ["one", "two"] },
      { kind: "table", headers: ["A", "B"], rows: [["1", "2"]] },
    ],
  );
});

test("parses inline markdown without treating raw html specially", () => {
  assert.deepEqual(
    parseMarkdownInline("**bold** `code` [link](https://example.com) <b>x</b>"),
    [
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "code" },
      { kind: "text", text: " " },
      {
        kind: "link",
        href: "https://example.com",
        children: [{ kind: "text", text: "link" }],
      },
      { kind: "text", text: " <b>x</b>" },
    ],
  );
});
