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

import { StateGraph, END, START } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { v4 as uuidv4 } from "uuid";

import {
  ResearchState,
  ReasoningEntry,
  createInitialState,
} from "./state";

import {
  thinkerNode,
  auditorNode,
  hitlGateNode,
  toolExecutorNode,
  synthesizerNode,
} from "./nodes";

import {
  routeAfterAudit,
  routeAfterHitl,
  routeAfterToolStep,
} from "./routing";

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
    // Nodes
    .addNode("thinker",       thinkerNode)
    .addNode("auditor",       auditorNode)
    .addNode("hitl_gate",     hitlGateNode)
    .addNode("tool_executor", toolExecutorNode)
    .addNode("synthesizer",   synthesizerNode)

    // Edges
    .addEdge(START,         "thinker")
    .addEdge("thinker",     "auditor")

    .addConditionalEdges("auditor", routeAfterAudit, {
      thinker:   "thinker",
      hitl_gate: "hitl_gate",
      [END]:      END,
    })

    .addConditionalEdges("hitl_gate", routeAfterHitl, {
      tool_executor: "tool_executor",
      [END]:          END,
    })

    .addConditionalEdges("tool_executor", routeAfterToolStep, {
      tool_executor: "tool_executor",
      synthesizer:   "synthesizer",
    })

    .addEdge("synthesizer", END);

  return graph.compile({ checkpointer, interruptBefore: [] });
}

// ─────────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────────

const checkpointer = new MemorySaver();
export const deepTrustGraph = buildDeepTrustGraph(checkpointer);

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

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

  await deepTrustGraph.updateState(config, { humanApproved: true });

  for await (const _ of await deepTrustGraph.stream(null, config)) {
    // Caller can also pass this generator to their own event loop
  }
}
