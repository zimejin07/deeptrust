/**
 * graph.ts — DeepTrust Research Agent
 *
 * Defines the full StateGraph lifecycle:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │   [START] ──► thinker ──► auditor ──► tool_executor      │
 *   │                  ▲           │              │            │
 *   │                  │    reject │              │            │
 *   │                  └───────────┘              ▼            │
 *   │                                       synthesizer        │
 *   │                                            │             │
 *   │                                         [END]            │
 *   └──────────────────────────────────────────────────────────┘
 *
 * HITL interrupt fires between auditor approval and tool_executor,
 * giving operators a chance to review the plan before any tool runs.
 *
 * Every node writes to `state.reasoning` for full observability.
 */

import { StateGraph, END, START, interrupt } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { pipeline, TextGenerationPipeline } from "@huggingface/transformers";
import { v4 as uuidv4 } from "uuid";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ResearchState,
  ResearchPlan,
  ResearchStep,
  AuditResult,
  ReasoningEntry,
  NodeName,
  appendReasoning,
  createInitialState,
} from "./state";

// ─────────────────────────────────────────────────────────────
// LLM Client (Hugging Face Transformers — local inference)
// ─────────────────────────────────────────────────────────────

const MODEL_ID = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-360M-Instruct";

// Lazy-load the pipeline (downloads model on first use)
let generatorPromise: Promise<TextGenerationPipeline> | null = null;

function getGenerator(): Promise<TextGenerationPipeline> {
  if (!generatorPromise) {
    console.log(`Loading model: ${MODEL_ID} (this may take a while on first run)...`);
    generatorPromise = pipeline("text-generation", MODEL_ID) as Promise<TextGenerationPipeline>;
  }
  return generatorPromise;
}

async function chatComplete(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const generator = await getGenerator();

  // Format as chat messages for instruct models
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const output = await generator(messages, {
    max_new_tokens: 4096,
    do_sample: true,
    temperature: 0.7,
  });

  // Extract generated text from the assistant response
  const result = output[0] as { generated_text: Array<{ role: string; content: string }> };
  const assistantMessage = result.generated_text.find(
    (msg) => msg.role === "assistant"
  );
  
  if (!assistantMessage) {
    throw new Error("No assistant response generated");
  }
  
  return assistantMessage.content;
}

// ─────────────────────────────────────────────────────────────
// Policy loader (used by Auditor)
// ─────────────────────────────────────────────────────────────

function loadPolicy(): string {
  try {
    return readFileSync(join(process.cwd(), "POLICY.md"), "utf-8");
  } catch {
    // Fallback inline policy so the graph never crashes on missing file
    return `
# DeepTrust Default Policy
- Never access personal, private, or confidential data sources.
- Never execute code that modifies the host filesystem.
- Never make more than 10 external HTTP requests per session.
- Research must be directly related to the user's stated objective.
- All sources must be attributable and verifiable.
    `.trim();
  }
}

// ─────────────────────────────────────────────────────────────
// Node: thinker
// ─────────────────────────────────────────────────────────────

/**
 * Produces (or revises) a structured ResearchPlan.
 * When `state.rejectionFeedback` is set, the model receives the
 * Auditor's critique and is instructed to produce a corrected plan.
 */
async function thinkerNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  const isRevision = state.planRevisionCount > 0 && state.rejectionFeedback;

  const system = `
You are the Thinker node of DeepTrust, an autonomous research agent.
Your sole job is to decompose a research question into a concrete, step-by-step plan.

Return ONLY a valid JSON object that matches this TypeScript type:
{
  "objective": string,
  "steps": Array<{
    "id": string (UUID v4),
    "tool": "web_search" | "document_fetch" | "code_interpreter" | "summarize",
    "input": string,
    "rationale": string
  }>,
  "estimatedTokenBudget": number,
  "createdAt": string (ISO 8601),
  "revision": number
}

Rules:
- Maximum 20 steps.
- Every step must have a clear rationale.
- Do not include markdown fences or any prose outside the JSON object.
  `.trim();

  const revisionContext = isRevision
    ? `\n\nPREVIOUS PLAN WAS REJECTED. Auditor feedback:\n${state.rejectionFeedback}\n\nRevision #${state.planRevisionCount + 1}: Produce a corrected plan.`
    : "";

  const userMessage = `Research question: "${state.userQuery}"${revisionContext}`;

  const rawThought = await chatComplete(system, userMessage);

  // Parse and validate the plan
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawThought);
  } catch {
    throw new Error(`Thinker produced non-JSON output: ${rawThought.slice(0, 200)}`);
  }

  const plan = ResearchPlan.parse({
    ...(parsed as object),
    revision: state.planRevisionCount,
  });

  const reasoning = appendReasoning(state, {
    node: "thinker",
    summary: isRevision
      ? `Revised plan (attempt ${state.planRevisionCount + 1}): ${plan.steps.length} steps for "${plan.objective}"`
      : `Initial plan created: ${plan.steps.length} steps for "${plan.objective}"`,
    rawThought,
  });

  return {
    plan,
    status: "thinking",
    rejectionFeedback: null, // consumed — clear it
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Node: auditor
// ─────────────────────────────────────────────────────────────

/**
 * Compares the current plan against POLICY.md.
 * Sets `auditResult` with verdict + structured feedback.
 * If rejected, also sets `rejectionFeedback` and increments
 * `planRevisionCount` so the router can loop back to thinker.
 */
async function auditorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) {
    throw new Error("auditorNode called with no plan in state");
  }

  const policy = loadPolicy();

  const system = `
You are the Auditor node of DeepTrust.
You evaluate research plans against an organisational policy and return a structured verdict.

Return ONLY a valid JSON object matching:
{
  "verdict": "approved" | "rejected" | "needs_revision",
  "policyViolations": string[],
  "suggestions": string[],
  "auditedAt": string (ISO 8601)
}

Rules:
- "approved" means the plan fully complies with policy.
- "rejected" means the plan has hard violations that cannot be patched.
- "needs_revision" means soft issues exist but the plan is salvageable.
- Treat "needs_revision" as rejection for routing purposes.
- Do not include markdown fences or any prose outside the JSON object.
  `.trim();

  const userMessage = `
POLICY:
${policy}

PLAN TO AUDIT:
${JSON.stringify(state.plan, null, 2)}
  `.trim();

  const rawThought = await chatComplete(system, userMessage);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawThought);
  } catch {
    throw new Error(`Auditor produced non-JSON output: ${rawThought.slice(0, 200)}`);
  }

  const auditResult = AuditResult.parse({
    ...(parsed as object),
    auditedAt: new Date().toISOString(),
  });

  const isRejected = auditResult.verdict !== "approved";

  const rejectionFeedback: string | null = isRejected
    ? [
        `Verdict: ${auditResult.verdict}`,
        auditResult.policyViolations.length
          ? `Violations:\n${auditResult.policyViolations.map((v) => `  - ${v}`).join("\n")}`
          : null,
        auditResult.suggestions.length
          ? `Suggestions:\n${auditResult.suggestions.map((s) => `  - ${s}`).join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n")
    : null;

  const reasoning = appendReasoning(state, {
    node: "auditor",
    summary: isRejected
      ? `Plan REJECTED (${auditResult.verdict}). ${auditResult.policyViolations.length} violation(s) found.`
      : "Plan APPROVED — no policy violations detected.",
    rawThought,
  });

  return {
    auditResult,
    rejectionFeedback,
    planRevisionCount: isRejected
      ? state.planRevisionCount + 1
      : state.planRevisionCount,
    status: isRejected ? "thinking" : "awaiting_approval",
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Node: hitl_gate  (Human-in-the-Loop interrupt)
// ─────────────────────────────────────────────────────────────

/**
 * Pauses the graph and surfaces the plan to the operator.
 * When the graph is resumed (via .updateState()), the caller
 * must set `state.humanApproved = true` to proceed.
 *
 * Using LangGraph's `interrupt()` primitive ensures the
 * checkpoint is written BEFORE the interrupt fires, so the
 * session can be resumed from any client or process.
 */
async function hitlGateNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  const reasoning = appendReasoning(state, {
    node: "thinker", // logged under thinker namespace for UI grouping
    summary: "⏸ HITL gate: awaiting human approval before tool execution.",
  });

  // This call writes a checkpoint and suspends until the graph
  // is resumed externally.  The value passed to interrupt() is
  // surfaced to the caller of `graph.stream()`.
  interrupt({
    message: "Plan ready for review. Set humanApproved=true to continue.",
    plan: state.plan,
    auditResult: state.auditResult,
  });

  // Code below only runs after the interrupt is resolved.
  return {
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Node: tool_executor
// ─────────────────────────────────────────────────────────────

/**
 * Executes one step at a time (the step at `currentStepIndex`).
 * After each execution the graph loops back through the router;
 * when all steps are complete it advances to synthesizer.
 *
 * Real tool integrations (Tavily, Playwright, etc.) replace the
 * stub `dispatchTool` function.
 */
async function toolExecutorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) throw new Error("toolExecutorNode called with no plan");

  const step = state.plan.steps[state.currentStepIndex];
  if (!step) throw new Error(`No step at index ${state.currentStepIndex}`);

  // ── Dispatch (replace stubs with real implementations) ─────
  const output = await dispatchTool(step.tool, step.input);

  // Persist the output back into the plan's steps array immutably
  const updatedSteps = state.plan.steps.map((s, i) =>
    i === state.currentStepIndex
      ? { ...s, output, executedAt: new Date().toISOString() }
      : s
  );

  const updatedPlan = ResearchPlan.parse({
    ...state.plan,
    steps: updatedSteps,
  });

  const reasoning = appendReasoning(state, {
    node: "tool_executor",
    summary: `Executed step ${state.currentStepIndex + 1}/${state.plan.steps.length}: [${step.tool}] "${step.input.slice(0, 80)}…"`,
    rawThought: output,
  });

  return {
    plan: updatedPlan,
    currentStepIndex: state.currentStepIndex + 1,
    status: "executing",
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

/** Stub dispatcher — replace each case with a real tool call. */
async function dispatchTool(
  tool: ResearchStep["tool"],
  input: string
): Promise<string> {
  switch (tool) {
    case "web_search":
      // e.g. return await tavilySearch(input);
      return `[STUB] web_search result for: "${input}"`;
    case "document_fetch":
      // e.g. return await fetchDocument(input);
      return `[STUB] document_fetch result for: "${input}"`;
    case "code_interpreter":
      // e.g. return await runSandboxedCode(input);
      return `[STUB] code_interpreter result for: "${input}"`;
    case "summarize":
      // e.g. return await summarizeText(input);
      return `[STUB] summarize result for: "${input}"`;
    default: {
      const exhaustiveCheck: never = tool;
      throw new Error(`Unknown tool: ${exhaustiveCheck}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Node: synthesizer
// ─────────────────────────────────────────────────────────────

/**
 * Reads all step outputs and produces the final research report.
 */
async function synthesizerNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) throw new Error("synthesizerNode called with no plan");

  const system = `
You are the Synthesizer node of DeepTrust.
You receive a research plan with all step outputs filled in,
and you write a comprehensive, well-structured research report.

Guidelines:
- Lead with an executive summary.
- Organise findings by theme, not by tool execution order.
- Cite which step produced each finding.
- End with actionable conclusions.
  `.trim();

  const stepsContext = state.plan.steps
    .map(
      (s, i) =>
        `Step ${i + 1} [${s.tool}] — "${s.input}"\nOutput: ${s.output ?? "(no output)"}`
    )
    .join("\n\n---\n\n");

  const userMessage = `
Objective: ${state.plan.objective}

Research results:
${stepsContext}
  `.trim();

  const finalReport = await chatComplete(system, userMessage);

  const reasoning = appendReasoning(state, {
    node: "synthesizer",
    summary: `Final report synthesized (${finalReport.length} chars).`,
  });

  return {
    finalReport,
    status: "complete",
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Routing functions (conditional edges)
// ─────────────────────────────────────────────────────────────

/** After auditor: loop back to thinker or advance to HITL gate. */
function routeAfterAudit(
  state: ResearchState
): "thinker" | "hitl_gate" | typeof END {
  // Hard stop — too many failed revisions
  if (state.planRevisionCount >= state.maxPlanRevisions) {
    return END;
  }
  if (state.auditResult?.verdict !== "approved") {
    return "thinker";
  }
  return "hitl_gate";
}

/** After HITL gate: block until human approves, then execute. */
function routeAfterHitl(
  state: ResearchState
): "tool_executor" | typeof END {
  if (!state.humanApproved) {
    // Graph should not reach here without approval; fail safe.
    return END;
  }
  return "tool_executor";
}

/** After each tool step: keep executing or move to synthesizer. */
function routeAfterToolStep(
  state: ResearchState
): "tool_executor" | "synthesizer" {
  const totalSteps = state.plan?.steps.length ?? 0;
  if (state.currentStepIndex < totalSteps) {
    return "tool_executor";
  }
  return "synthesizer";
}

// ─────────────────────────────────────────────────────────────
// Graph construction
// ─────────────────────────────────────────────────────────────

/**
 * Builds and compiles the DeepTrust StateGraph.
 *
 * The `checkpointer` defaults to MemorySaver (in-process, dev-only).
 * Pass a PostgresSaver instance for production persistence.
 */
export function buildDeepTrustGraph(
  checkpointer: MemorySaver = new MemorySaver()
) {
  const graph = new StateGraph<ResearchState>({
    // LangGraph uses this to know which keys to merge on update
    channels: {
      threadId:         { value: (_, n) => n },
      sessionName:      { value: (_, n) => n },
      userQuery:        { value: (_, n) => n },
      plan:             { value: (_, n) => n },
      rejectionFeedback:{ value: (_, n) => n },
      planRevisionCount:{ value: (_, n) => n },
      maxPlanRevisions: { value: (_, n) => n },
      auditResult:      { value: (_, n) => n },
      currentStepIndex: { value: (_, n) => n },
      humanApproved:    { value: (_, n) => n },
      finalReport:      { value: (_, n) => n },
      // reasoning is append-only — merge by concatenation
      reasoning: {
        value: (existing: ReasoningEntry[], incoming: ReasoningEntry[]) =>
          [...(existing ?? []), ...(incoming ?? [])],
        default: () => [],
      },
      status:       { value: (_, n) => n },
      updatedAt:    { value: (_, n) => n },
      errorMessage: { value: (_, n) => n },
    },
  })
    // ── Nodes ──────────────────────────────────────────────
    .addNode("thinker",       thinkerNode)
    .addNode("auditor",       auditorNode)
    .addNode("hitl_gate",     hitlGateNode)
    .addNode("tool_executor", toolExecutorNode)
    .addNode("synthesizer",   synthesizerNode)

    // ── Edges ──────────────────────────────────────────────
    .addEdge(START,         "thinker")
    .addEdge("thinker",     "auditor")

    // Auditor → loop back to thinker OR advance to HITL gate
    .addConditionalEdges("auditor", routeAfterAudit, {
      thinker:   "thinker",
      hitl_gate: "hitl_gate",
      [END]:      END,
    })

    // HITL gate → wait for human OR end
    .addConditionalEdges("hitl_gate", routeAfterHitl, {
      tool_executor: "tool_executor",
      [END]:          END,
    })

    // Tool executor → loop through steps OR synthesize
    .addConditionalEdges("tool_executor", routeAfterToolStep, {
      tool_executor: "tool_executor",
      synthesizer:   "synthesizer",
    })

    .addEdge("synthesizer", END);

  return graph.compile({ checkpointer, interruptBefore: [] });
}

// ─────────────────────────────────────────────────────────────
// Public API helpers
// ─────────────────────────────────────────────────────────────

/** Singleton graph instance (re-use the same checkpointer). */
const checkpointer = new MemorySaver();
export const deepTrustGraph = buildDeepTrustGraph(checkpointer);

/**
 * Start a new research session and stream events to the caller.
 *
 * @example
 * ```ts
 * for await (const event of runResearch("What caused the 2008 crisis?")) {
 *   console.log(event);
 * }
 * ```
 */
export async function* runResearch(
  userQuery: string,
  sessionName = "Research Session"
): AsyncGenerator<{ node: string; state: Partial<ResearchState> }> {
  const initialState = createInitialState({
    threadId: uuidv4(),
    userQuery,
    sessionName,
  });

  const config = { configurable: { thread_id: initialState.threadId } };

  for await (const event of await deepTrustGraph.stream(initialState, config)) {
    for (const [node, state] of Object.entries(event)) {
      yield { node, state: state as Partial<ResearchState> };
    }
  }
}

/**
 * Resume a paused session after human approval.
 *
 * The caller retrieves the latest checkpoint, sets `humanApproved`,
 * and calls this to resume execution from the HITL gate.
 */
export async function approveAndResume(
  threadId: string
): Promise<void> {
  const config = { configurable: { thread_id: threadId } };

  // Patch humanApproved into the stored checkpoint
  await deepTrustGraph.updateState(config, { humanApproved: true });

  // Resume — null input continues from the last checkpoint
  for await (const _ of await deepTrustGraph.stream(null, config)) {
    // Caller can also pass this generator to their own event loop
  }
}
