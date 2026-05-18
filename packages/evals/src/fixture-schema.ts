import { z } from "zod";

import { EVAL_PROVIDER_VALUES } from "./v2-contracts.ts";

const providerSchema = z.enum(EVAL_PROVIDER_VALUES);

export const codeAssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file_contains"),
    path: z.string(),
    pattern: z.string(),
  }),
  z.object({
    type: z.literal("fs_unchanged_outside"),
    root: z.string(),
  }),
  z.object({
    type: z.literal("approval_status"),
    actionType: z.string(),
    expected: z.enum(["approved", "rejected", "pending"]),
  }),
  z.object({
    type: z.literal("recorded_request_contains"),
    needle: z.string(),
  }),
  z.object({
    type: z.literal("repair_attempts_eq"),
    expected: z.number().int().nonnegative(),
  }),
]);

export const codeGraderSchema = z.object({
  kind: z.literal("code"),
  assertion: codeAssertionSchema,
});

export const ruleGraderSchema = z.object({
  kind: z.literal("rule"),
  rules: z.array(
    z.object({
      description: z.string().min(1),
      check: z.enum(["regex", "schema", "count"]),
      target: z.string().min(1),
      pattern: z.string().optional(),
      schemaRef: z.string().optional(),
      count: z
        .object({
          min: z.number().int().nonnegative().optional(),
          max: z.number().int().nonnegative().optional(),
        })
        .optional(),
    }),
  ),
});

export const llmJudgeGraderSchema = z.object({
  kind: z.literal("llm_judge"),
  rubric: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        weight: z.number().positive(),
      }),
    )
    .min(1),
  passThreshold: z.number().min(0).max(1).default(0.8).optional(),
  judgeProvider: providerSchema.optional(),
  judgeAttempts: z.number().int().min(1).max(5).default(3).optional(),
  maxJudgeTokens: z.number().int().positive().optional(),
});

export const graderSchema = z.discriminatedUnion("kind", [
  codeGraderSchema,
  ruleGraderSchema,
  llmJudgeGraderSchema,
]);

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(["capability", "regression", "safety"]),
  title: z.string().min(1),
  instruction: z.string().min(1),
  scenario: z.string().min(1),
  attempts: z.number().int().min(1).max(10).default(3),
  provider: providerSchema.optional(),
  providers: z
    .array(providerSchema)
    .min(1)
    .max(EVAL_PROVIDER_VALUES.length)
    .refine((providers) => new Set(providers).size === providers.length, {
      message: "providers must be unique",
    })
    .optional(),
  profile: z
    .object({
      blockedActions: z.array(z.string()).optional(),
      autoApprove: z.boolean().optional(),
    })
    .optional(),
  grader: graderSchema,
  thresholds: z
    .object({
      passAt3: z.number().min(0).max(1).optional(),
      passToThe3: z.number().min(0).max(1).optional(),
      safetyFailures: z.literal(0).optional(),
    })
    .optional(),
  budgetTokens: z.number().int().positive().optional(),
});

export type EvalCaseInput = z.infer<typeof evalCaseSchema>;
