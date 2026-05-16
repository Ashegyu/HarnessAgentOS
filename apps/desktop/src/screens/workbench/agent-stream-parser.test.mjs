import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedStreamChunk,
  flushStreamParser,
  hydrateSavedAgentOutput,
  initStreamParserState,
  promoteIntermediateTextToFinal,
  setIntermediateAssistantText,
} from "./agent-stream-parser.ts";

const line = (obj) => JSON.stringify(obj) + "\n";

test("text_delta events accumulate into liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello " },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      }),
  );
  assert.equal(s.parsed.liveText, "hello world");
  assert.equal(s.parsed.finalText, null);
});

test("result line populates finalText and resultMeta", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1500,
      duration_api_ms: 1100,
      result: "pong",
      stop_reason: "end_turn",
      session_id: "sess-1",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  );
  assert.equal(s.parsed.finalText, "pong");
  assert.deepEqual(s.parsed.resultMeta, {
    isError: false,
    durationMs: 1500,
    durationApiMs: 1100,
    stopReason: "end_turn",
    costUsd: 0.0123,
    usage: { input_tokens: 5, output_tokens: 2 },
    sessionId: "sess-1",
  });
});

test("persisted harness result records approximate token metadata", () => {
  const s = initStreamParserState();
  hydrateSavedAgentOutput(
    s,
    [
      line({
        type: "assistant_text",
        invocationId: "inv-1",
        text: "done",
      }),
      line({
        type: "result",
        invocationId: "inv-1",
        latencyMs: 123,
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          estimate_source: "heuristic",
          approximate: true,
        },
        usageApproximate: true,
      }),
    ].join(""),
    { terminal: true },
  );
  assert.equal(s.parsed.finalText, "done");
  assert.equal(s.parsed.resultMeta?.usage?.total_tokens, 14);
  assert.equal(s.parsed.resultMeta?.usageApproximate, true);
});

test("result line normalizes harness_agent_plan output to the plan summary", () => {
  const s = initStreamParserState();
  const planOutput = {
    summary: "프로젝트 구조와 실행 흐름을 분석했습니다.",
    assumptions: [],
    steps: [{ title: "분석", rationale: "요청 처리", risk: "low" }],
    proposedActions: [
      {
        type: "file_write",
        path: "report.html",
        after: "<html>large report</html>",
        rationale: "보고서 저장",
      },
    ],
    suggestedQualityChecks: [
      { command: "start report.html", reason: "브라우저 렌더링 확인" },
    ],
    questions: [],
  };

  feedStreamChunk(
    s,
    line({
      type: "result",
      is_error: false,
      duration_ms: 1500,
      duration_api_ms: 1100,
      result: `설명\n\n\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
    }),
  );

  assert.equal(s.parsed.finalText, planOutput.summary);
  assert.equal(s.parsed.intermediateText, "설명");
  assert.match(s.parsed.thinkingText, /분석: 요청 처리/);
  assert.deepEqual(s.parsed.toolUses, [
    {
      name: "file_write",
      input: {
        path: "report.html",
        rationale: "보고서 저장",
        contentLength: "<html>large report</html>".length,
      },
    },
    {
      name: "quality_check",
      input: {
        command: "start report.html",
        reason: "브라우저 렌더링 확인",
      },
    },
  ]);
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["response", "thinking", "tool", "tool", "final"],
  );
  assert.doesNotMatch(s.parsed.finalText, /proposedActions/);
  assert.doesNotMatch(s.parsed.finalText, /<html>/);
});

test("tool_use name captured on content_block_start", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Read", input: {} },
      },
    }),
  );
  assert.equal(s.parsed.toolUses.length, 1);
  assert.equal(s.parsed.toolUses[0].name, "Read");
  assert.equal(s.parsed.toolUses[0].input, null);
});

test("tool_use input assembled from input_json_delta and finalised on content_block_stop", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Read", input: {} },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"/x.md"}' },
        },
      }) +
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
  );
  assert.deepEqual(s.parsed.toolUses, [{ name: "Read", input: { path: "/x.md" } }]);
});

test("hooks and rate_limit_event are recorded", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "system",
      subtype: "hook_started",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart",
    }) +
      line({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1234, overageStatus: "ok" },
      }),
  );
  assert.equal(s.parsed.hooks.length, 1);
  assert.equal(s.parsed.hooks[0].phase, "started");
  assert.equal(s.parsed.rateLimit?.status, "allowed");
});

test("post_turn_summary is captured", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "system",
      subtype: "post_turn_summary",
      status_category: "review_ready",
      status_detail: "pong",
    }),
  );
  assert.deepEqual(s.parsed.turnSummary, {
    status: "review_ready",
    detail: "pong",
  });
});

test("split-across-chunk lines are reassembled", () => {
  const s = initStreamParserState();
  const full = line({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "abc" },
    },
  });
  // feed in three pieces — boundaries inside the JSON and between lines
  feedStreamChunk(s, full.slice(0, 20));
  feedStreamChunk(s, full.slice(20, 50));
  feedStreamChunk(s, full.slice(50));
  assert.equal(s.parsed.liveText, "abc");
});

test("non-JSON tail line surfaces via unknown after flush", () => {
  const s = initStreamParserState();
  feedStreamChunk(s, "this is not json");
  flushStreamParser(s);
  assert.deepEqual(s.parsed.unknown, ["this is not json"]);
});

test("thinking_delta events accumulate into thinkingText, separate from liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me " },
        },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think about this..." },
        },
      }) +
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Answer." },
        },
      }),
  );
  assert.equal(s.parsed.thinkingText, "Let me think about this...");
  assert.equal(s.parsed.liveText, "Answer.");
  assert.equal(s.parsed.finalText, null);
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["thinking", "response"],
  );
});

test("stream sections preserve arrival order across repeated section kinds", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "inspect " },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "I will check " },
        },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", name: "Shell", input: {} },
        },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"command":"npm test"}' },
        },
      }) +
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 2 },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 3,
          delta: { type: "text_delta", text: "then summarize." },
        },
      }),
  );

  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["thinking", "response", "tool", "response"],
  );
  assert.equal(s.parsed.sections[0].text, "inspect ");
  assert.equal(s.parsed.sections[1].text, "I will check ");
  assert.equal(s.parsed.sections[2].name, "Shell");
  assert.deepEqual(s.parsed.sections[2].input, { command: "npm test" });
  assert.equal(s.parsed.sections[3].text, "then summarize.");
});

test("setIntermediateAssistantText records draft output without losing liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    }),
  );
  setIntermediateAssistantText(s, "draft answer");
  assert.equal(s.parsed.intermediateText, "draft answer");
  assert.equal(s.parsed.finalText, null);
  assert.equal(s.parsed.liveText, "partial");
});

test("result promotion moves intermediate assistant output to finalText", () => {
  const s = initStreamParserState();
  setIntermediateAssistantText(s, "final after result");
  assert.equal(s.parsed.finalText, null);

  promoteIntermediateTextToFinal(s);

  assert.equal(s.parsed.finalText, "final after result");
  assert.equal(s.parsed.intermediateText, "final after result");
});

test("result promotion removes the duplicate trailing intermediate section", () => {
  const s = initStreamParserState();
  setIntermediateAssistantText(s, "first draft");
  setIntermediateAssistantText(s, "final answer");

  promoteIntermediateTextToFinal(s);

  assert.equal(s.parsed.finalText, "final answer");
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["response", "final"],
  );
  assert.deepEqual(
    s.parsed.sections
      .filter((section) => section.kind === "response")
      .map((section) => section.text),
    ["first draft"],
  );
});

test("hydrateSavedAgentOutput preserves plain saved output as final text", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(s, "full saved answer\nwith details", {
    terminal: true,
    latencyMs: 1234,
  });

  assert.equal(s.parsed.finalText, "full saved answer\nwith details");
  assert.equal(s.parsed.intermediateText, "full saved answer\nwith details");
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["final"],
  );
  assert.deepEqual(s.parsed.unknown, []);
  assert.equal(s.parsed.resultMeta?.durationMs, 1234);
});

test("hydrateSavedAgentOutput normalizes saved harness_agent_plan text", () => {
  const s = initStreamParserState();
  const planOutput = {
    summary: "저장된 계획 요약만 최종 답변으로 표시합니다.",
    assumptions: [],
    steps: [],
    proposedActions: [
      {
        type: "file_write",
        path: "report.html",
        after: "<html>raw file body</html>",
        rationale: "보고서 저장",
      },
    ],
    suggestedQualityChecks: [],
    questions: [],
  };

  hydrateSavedAgentOutput(
    s,
    `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput, null, 2)}\n\`\`\``,
    { terminal: true },
  );

  assert.equal(s.parsed.intermediateText, planOutput.summary);
  assert.equal(s.parsed.finalText, planOutput.summary);
  assert.deepEqual(s.parsed.toolUses, [
    {
      name: "file_write",
      input: {
        path: "report.html",
        rationale: "보고서 저장",
        contentLength: "<html>raw file body</html>".length,
      },
    },
  ]);
  assert.doesNotMatch(s.parsed.finalText, /raw file body/);
});

test("hydrateSavedAgentOutput replays saved stream json lines", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "streamed answer" },
      },
    }),
    { terminal: true },
  );

  assert.equal(s.parsed.liveText, "streamed answer");
  assert.equal(s.parsed.finalText, "streamed answer");
});

test("hydrateSavedAgentOutput replays persisted Harness stream events", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(
    s,
    line({
      type: "progress",
      invocationId: "inv-1",
      taskRunId: "tr-1",
      stage: "cli",
      message: "CLI 프로세스 시작",
      detail: "codex:gpt-5.5 · cwd C:/work",
      at: "2026-05-15T00:00:00.000Z",
    }) +
      line({
        type: "raw",
        invocationId: "inv-1",
        source: "stdout",
        text: line({
          type: "item.delta",
          delta: "작성 중 ",
        }),
      }) +
      line({
        type: "raw",
        invocationId: "inv-1",
        source: "stdout",
        text: line({
          type: "item.completed",
          item: {
            type: "local_shell_call",
            command: "npm run check",
          },
        }),
      }) +
      line({
        type: "assistant_text",
        invocationId: "inv-1",
        text: "최종 정리",
      }) +
      line({
        type: "result",
        invocationId: "inv-1",
        latencyMs: 42,
      }),
    { terminal: true },
  );

  assert.equal(s.parsed.progress.length, 1);
  assert.equal(s.parsed.progress[0].stage, "cli");
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["response", "tool", "final"],
  );
  assert.equal(s.parsed.finalText, "최종 정리");
  assert.equal(s.parsed.resultMeta?.durationMs, 42);
});

test("hydrateSavedAgentOutput preserves completed stream sections", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "checking context" },
      },
    }) +
      line({
        type: "item.completed",
        item: {
          type: "local_shell_call",
          command: "npm run check",
        },
      }) +
      line({
        type: "item.completed",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: [{ type: "output_text", text: "draft answer" }],
        },
      }) +
      line({
        type: "result",
        is_error: false,
        duration_ms: 1200,
        duration_api_ms: 900,
        result: "final answer",
      }),
    { terminal: true },
  );

  assert.equal(s.parsed.thinkingText, "checking context");
  assert.deepEqual(s.parsed.toolUses, [
    { name: "local_shell_call", input: "npm run check" },
  ]);
  assert.equal(s.parsed.intermediateText, "draft answer");
  assert.equal(s.parsed.finalText, "final answer");
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["thinking", "tool", "response", "final"],
  );
  assert.equal(s.parsed.resultMeta?.durationMs, 1200);
});

test("codex delta events accumulate into liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({ type: "item.delta", delta: "hello " }) +
      line({ type: "item_delta", item: { delta: { text: "codex" } } }),
  );
  assert.equal(s.parsed.liveText, "hello codex");
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex completed assistant item stays intermediate while running", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({ type: "thread.started", thread_id: "thr-1" }) +
      line({ type: "turn.started" }) +
      line({
        type: "item.completed",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: [{ type: "output_text", text: "final answer" }],
        },
      }),
  );
  assert.equal(s.parsed.intermediateText, "final answer");
  assert.equal(s.parsed.finalText, null);
  assert.equal(s.parsed.resultMeta, null);
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex completed assistant snapshots append intermediate response sections", () => {
  const s = initStreamParserState();
  const completedAssistant = (text) =>
    line({
      type: "item.completed",
      item: {
        type: "assistant_message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    });

  feedStreamChunk(
    s,
    completedAssistant("첫 번째 중간 답변") +
      completedAssistant("두 번째 중간 답변") +
      completedAssistant("두 번째 중간 답변"),
  );

  assert.equal(s.parsed.intermediateText, "두 번째 중간 답변");
  assert.equal(s.parsed.finalText, null);
  assert.deepEqual(
    s.parsed.sections
      .filter((section) => section.kind === "response")
      .map((section) => ({ phase: section.phase, text: section.text })),
    [
      { phase: "intermediate", text: "첫 번째 중간 답변" },
      { phase: "intermediate", text: "두 번째 중간 답변" },
    ],
  );
});

test("codex response_item reasoning summary is captured as thinking", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "파일 구조 확인 중" }],
      },
    }),
  );

  assert.equal(s.parsed.thinkingText, "파일 구조 확인 중");
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["thinking"],
  );
});

test("codex response_item function_call is captured as command tool use", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({
          command: "npm run check",
          workdir: "C:\\work",
          timeout_ms: 10000,
        }),
        call_id: "call-1",
      },
    }) +
      line({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Exit code: 0\nOutput:\nok",
        },
      }),
  );

  assert.deepEqual(s.parsed.toolUses, [
    {
      name: "shell_command",
      input: {
        command: "npm run check",
        workdir: "C:\\work",
        timeout_ms: 10000,
      },
    },
  ]);
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["tool"],
  );
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex command_execution started and completed update one command section", () => {
  const s = initStreamParserState();
  const command =
    "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'rg --files'";

  feedStreamChunk(
    s,
    line({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command,
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }) +
      line({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command,
          aggregated_output: "package.json\napps/desktop/package.json\n",
          exit_code: 0,
          status: "completed",
        },
      }),
  );

  assert.deepEqual(s.parsed.toolUses, [
    {
      name: "command_execution",
      input: {
        command,
        status: "completed",
        exitCode: 0,
        outputPreview: "package.json\napps/desktop/package.json\n",
      },
    },
  ]);
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["tool"],
  );
  assert.equal(s.parsed.sections[0].input.status, "completed");
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex turn.completed records reasoning usage as thinking metadata", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        reasoning_output_tokens: 4415,
      },
    }),
  );

  assert.match(s.parsed.thinkingText, /Codex 내부 추론 사용량: 4415 tokens/);
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["thinking"],
  );
  assert.equal(s.parsed.resultMeta?.usage?.reasoning_output_tokens, 4415);
});

test("codex completed harness_agent_plan keeps sections while running", () => {
  const s = initStreamParserState();
  const planOutput = {
    summary: "최종 요약",
    assumptions: ["저장소 구조를 기준으로 판단"],
    steps: [{ title: "검토", rationale: "파일을 확인", risk: "low" }],
    proposedActions: [
      {
        type: "shell",
        command: "npm run check",
        rationale: "타입 체크",
      },
    ],
    suggestedQualityChecks: [],
    questions: [],
  };

  feedStreamChunk(
    s,
    line({
      type: "item.completed",
      item: {
        type: "assistant_message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `작성 중 설명\n\n\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          },
        ],
      },
    }),
  );

  assert.equal(s.parsed.intermediateText, "작성 중 설명");
  assert.equal(s.parsed.finalText, null);
  assert.match(s.parsed.thinkingText, /저장소 구조를 기준으로 판단/);
  assert.deepEqual(s.parsed.toolUses, [
    {
      name: "shell",
      input: {
        command: "npm run check",
        args: undefined,
        rationale: "타입 체크",
      },
    },
  ]);
  assert.deepEqual(
    s.parsed.sections.map((section) => section.kind),
    ["response", "thinking", "tool"],
  );
});

test("codex completed assistant item is final only after result promotion", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "item.completed",
      item: {
        type: "assistant_message",
        role: "assistant",
        content: [{ type: "output_text", text: "final answer" }],
      },
    }),
  );
  assert.equal(s.parsed.finalText, null);

  promoteIntermediateTextToFinal(s);

  assert.equal(s.parsed.finalText, "final answer");
  assert.equal(s.parsed.resultMeta?.isError, false);
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex tool item is captured as tool use", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "item.completed",
      item: {
        type: "local_shell_call",
        command: "npm test",
      },
    }),
  );
  assert.deepEqual(s.parsed.toolUses, [
    { name: "local_shell_call", input: "npm test" },
  ]);
});

test("codex failed turn records error summary", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "turn.failed",
      error: { message: "The model is not supported" },
    }),
  );
  assert.deepEqual(s.parsed.turnSummary, {
    status: "turn.failed",
    detail: "The model is not supported",
  });
  assert.equal(s.parsed.resultMeta?.isError, true);
});
