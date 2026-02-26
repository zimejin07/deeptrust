/**
 * state.ts — DeepTrust Research Agent
 *
 * Single source of truth for every field that flows through the
 * StateGraph.  Zod gives us runtime validation; the inferred TS
 * types keep every node strictly typed with zero `any` leakage.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────

/** Every legal node name in the graph – used to type routing returns. */
export const NodeName = z.enum([
  "thinker",
  "auditor",
  "tool_executor",
  "synthesizer",
  "__end__",
]);
export type NodeName = z.infer<typeof NodeName>;

/** Disposition returned by the Auditor node. */
export const AuditVerdict = z.enum(["approved", "rejected", "needs_revision"]);
export type AuditVerdict = z.infer<typeof AuditVerdict>;

/** Lifecycle of a single research run. */
export const RunStatus = z.enum([
  "idle",
  "thinking",
  "awaiting_approval", // HITL interrupt point
  "executing",
  "synthesizing",
  "complete",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatus>;

// ─────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────

/**
 * A single step inside a research plan.
 * The Thinker produces an array of these; the Tool Executor
 * works through them one-by-one.
 */
export const ResearchStep = z.object({
  id: z.string().uuid(),
  tool: z.enum(["web_search", "document_fetch", "code_interpreter", "summarize"]),
  input: z.string().min(1),
  rationale: z.string(),
  /** Populated by the Tool Executor after the step runs. */
  output: z.string().optional(),
  executedAt: z.string().datetime().optional(),
});
export type ResearchStep = z.infer<typeof ResearchStep>;

/**
 * The structured plan produced by the Thinker and evaluated
 * by the Auditor before any tool is touched.
 */
export const ResearchPlan = z.object({
  objective: z.string().min(1),
  steps: z.array(ResearchStep).min(1).max(20),
  estimatedTokenBudget: z.number().int().positive(),
  createdAt: z.string().datetime(),
  revision: z.number().int().nonnegative().default(0),
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;

/**
 * One entry in the reasoning trail — every node appends here
 * so the UI can replay the full thought process.
 */
export const ReasoningEntry = z.object({
  node: NodeName,
  timestamp: z.string().datetime(),
  summary: z.string(),
  /** Optional verbatim model output for deep-dive inspection. */
  rawThought: z.string().optional(),
});
export type ReasoningEntry = z.infer<typeof ReasoningEntry>;

/** Structured feedback from the Auditor when it rejects a plan. */
export const AuditResult = z.object({
  verdict: AuditVerdict,
  policyViolations: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  auditedAt: z.string().datetime(),
});
export type AuditResult = z.infer<typeof AuditResult>;

// ─────────────────────────────────────────────────────────────
// Root State Schema
// ─────────────────────────────────────────────────────────────

/**
 * ResearchState — the complete, checkpointable state object.
 *
 * LangGraph.js will serialise/deserialise this on every step,
 * so every field must be JSON-safe.  The checkpointer stores
 * snapshots keyed by `threadId`, enabling full rehydration.
 */
export const ResearchState = z.object({
  // ── Identity & Persistence ───────────────────────────────
  /** Stable identifier — passed to the checkpointer as the config key. */
  threadId: z.string().uuid(),
  /** Human-readable label shown in the UI. */
  sessionName: z.string().default("Unnamed Session"),

  // ── Input ────────────────────────────────────────────────
  /** The raw research question submitted by the user. */
  userQuery: z.string().min(1),

  // ── Planning ─────────────────────────────────────────────
  /** Current plan produced by the Thinker.  Null before first plan. */
  plan: ResearchPlan.nullable().default(null),

  /**
   * Feedback injected into the Thinker's context when the Auditor
   * rejects a plan.  Cleared after each successful audit.
   */
  rejectionFeedback: z.string().nullable().default(null),

  /** How many times the plan has cycled through Thinker→Auditor. */
  planRevisionCount: z.number().int().nonneg().default(0),

  /** Safety ceiling — prevents runaway revision loops. */
  maxPlanRevisions: z.number().int().positive().default(5),

  // ── Auditing ─────────────────────────────────────────────
  /** The most recent audit result.  Null before first audit. */
  auditResult: AuditResult.nullable().default(null),

  // ── Execution ────────────────────────────────────────────
  /** Index into `plan.steps` for the currently-executing step. */
  currentStepIndex: z.number().int().nonneg().default(0),

  /**
   * Whether the user has explicitly approved the plan.
   * The graph checks this before transitioning to tool_executor.
   */
  humanApproved: z.boolean().default(false),

  // ── Output ───────────────────────────────────────────────
  /** Final synthesized report.  Null until synthesizer runs. */
  finalReport: z.string().nullable().default(null),

  // ── Observability ────────────────────────────────────────
  /**
   * Append-only log of every node's reasoning.
   * The UI streams this list to render a live "thought process" view.
   */
  reasoning: z.array(ReasoningEntry).default([]),

  // ── Lifecycle ────────────────────────────────────────────
  status: RunStatus.default("idle"),

  /** ISO timestamp of the last state mutation. */
  updatedAt: z.string().datetime(),

  /** Non-null when the run terminated with an unrecoverable error. */
  errorMessage: z.string().nullable().default(null),
});

export type ResearchState = z.infer<typeof ResearchState>;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Append a reasoning entry without mutating the caller's reference. */
export function appendReasoning(
  state: ResearchState,
  entry: Omit<ReasoningEntry, "timestamp">
): ReasoningEntry[] {
  const stamped: ReasoningEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  return [...state.reasoning, stamped];
}

/** Returns a fresh, validated initial state for a new session. */
export function createInitialState(
  params: Pick<ResearchState, "threadId" | "userQuery" | "sessionName">
): ResearchState {
  return ResearchState.parse({
    ...params,
    updatedAt: new Date().toISOString(),
  });
}
