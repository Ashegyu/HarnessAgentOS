import type {
  ApprovalActionType,
  GeneratedSkillDraft,
  SkillGenerationRequest,
} from "@harness/core";
import { createHash } from "node:crypto";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "skill",
  "agent",
  "please",
]);

const ACTION_RULES: readonly {
  action: ApprovalActionType;
  pattern: RegExp;
}[] = [
  {
    action: "file_write",
    pattern:
      /\b(write|edit|modify|patch|refactor|code|document|generate|create|implement)\b|파일|수정|작성|생성|구현|문서/i,
  },
  {
    action: "shell",
    pattern:
      /\b(shell|command|script|run|test|build|lint|typecheck|install)\b|명령|스크립트|실행|테스트|빌드|검증/i,
  },
  {
    action: "network",
    pattern:
      /\b(api|http|https|mcp|web|fetch|download|github|gmail|slack|notion|network)\b|원격|네트워크|다운로드/i,
  },
  {
    action: "skill_script",
    pattern: /\b(skill_script|skill script)\b|스킬\s*스크립트/i,
  },
];

const HIGH_RISK_PATTERN =
  /\b(secret|token|credential|password|delete|remove|deploy|production|admin|oauth)\b|비밀|토큰|삭제|배포|운영|관리자/i;

export const buildGeneratedSkillDraft = (
  request: SkillGenerationRequest,
): GeneratedSkillDraft => {
  const intent = compactWhitespace(request.userIntent);
  const summary = summarizeIntent(intent);
  const triggerTerms = triggerTermsFromIntent(intent);
  const allowedActions = inferAllowedActions(intent);
  const riskLevel = HIGH_RISK_PATTERN.test(intent)
    ? "high"
    : allowedActions.length > 0
      ? "medium"
      : "low";
  const slug = slugFromIntent(intent, triggerTerms);
  const name = nameFromSummary(summary);
  const description = `Use this skill when the request is about ${summary}.`;

  return {
    sourceId: request.sourceId.trim(),
    slug,
    name,
    description: truncateSentence(description, 180),
    triggerTerms,
    riskLevel,
    allowedActions,
    body: renderGeneratedBody({ summary, allowedActions }),
    recommendedProfileIds: [...(request.profileIds ?? [])],
    rationale:
      "Generated from user intent only; materialization still requires preview, approval, and runner execution.",
  };
};

const compactWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const summarizeIntent = (intent: string): string => {
  if (intent.length === 0) return "a reusable workflow";
  const firstSentence = intent.split(/[.!?\n]/)[0]?.trim() ?? intent;
  return truncateSentence(firstSentence, 120);
};

const nameFromSummary = (summary: string): string => {
  const asciiWords = summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 4);
  if (asciiWords.length > 0) {
    return `${asciiWords.map(titleCase).join(" ")} Skill`;
  }
  return truncateSentence(`Generated Skill: ${summary}`, 80);
};

const triggerTermsFromIntent = (intent: string): string[] => {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of intent.split(/[^\p{L}\p{N}_-]+/u)) {
    const term = raw.trim().toLowerCase();
    if (term.length < 2 || term.length > 32) continue;
    if (STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 8) break;
  }
  return terms.length > 0 ? terms : ["generated-skill"];
};

const inferAllowedActions = (intent: string): ApprovalActionType[] => {
  const actions: ApprovalActionType[] = [];
  for (const rule of ACTION_RULES) {
    if (rule.pattern.test(intent)) actions.push(rule.action);
  }
  return actions;
};

const slugFromIntent = (intent: string, terms: readonly string[]): string => {
  const asciiTerms = terms
    .map((term) => term.replace(/[^a-z0-9_-]+/g, ""))
    .filter((term) => /^[a-z0-9][a-z0-9_-]*$/.test(term))
    .slice(0, 4);
  const hash = createHash("sha1").update(intent || "generated-skill").digest("hex").slice(0, 6);
  const base = asciiTerms.length > 0 ? asciiTerms.join("-") : "generated-skill";
  const maxBase = 63 - hash.length - 1;
  return `${base.slice(0, maxBase).replace(/[-_]+$/g, "")}-${hash}`;
};

const renderGeneratedBody = (input: {
  summary: string;
  allowedActions: readonly ApprovalActionType[];
}): string =>
  [
    `Use this skill when the user's request is about ${input.summary}.`,
    "",
    "Workflow:",
    "1. Restate the user-visible goal and the current repository or task context.",
    "2. Gather the minimum evidence needed before proposing changes.",
    "3. Produce a concise plan or implementation guidance that can be reviewed.",
    "4. Route every file, command, network, or script side effect through Harness approval and runner execution.",
    "",
    "Safety:",
    "- Do not write files, run commands, call networks, or execute scripts directly from the skill body.",
    "- Do not hide generated changes from the user.",
    `- Declared side-effect categories: ${input.allowedActions.length > 0 ? input.allowedActions.join(", ") : "none"}.`,
  ].join("\n");

const truncateSentence = (value: string, max: number): string => {
  const trimmed = compactWhitespace(value);
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}.`;
};

const titleCase = (value: string): string =>
  value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
