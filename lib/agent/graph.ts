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

import { StateGraph, END, START, MemorySaver, Command } from "@langchain/langgraph";
import { v4 as uuidv4 } from "uuid";

import {
  ResearchState,
  ReasoningEntry,
  MAX_REASONING_ENTRIES,
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
      knowledgeContext: { value: (_, n) => n },
      contextUrls:      { value: (_, n) => n },
      plan:             { value: (_, n) => n },
      rejectionFeedback:{ value: (_, n) => n },
      planRevisionCount:{ value: (_, n) => n },
      maxPlanRevisions: { value: (_, n) => n },
      auditResult:      { value: (_, n) => n },
      currentStepIndex: { value: (_, n) => n },
      humanApproved:    { value: (_, n) => n },
      finalReport:      { value: (_, n) => n },
      reasoning: {
        value: (existing: ReasoningEntry[], incoming: ReasoningEntry[]) => {
          const merged = [...(existing ?? []), ...(incoming ?? [])];
          return merged.length > MAX_REASONING_ENTRIES
            ? merged.slice(merged.length - MAX_REASONING_ENTRIES)
            : merged;
        },
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

export interface RunResearchOptions {
  knowledgeContext?: string;
  contextUrls?: string[];
  /**
   * Optional metadata forwarded to LangGraph / LangSmith.
   * Useful for grouping and searching traces.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Start a new research session and stream events to the caller.
 * Optionally pass retrieved context from client-side RAG (knowledgeContext, contextUrls).
 *
 * @example
 * ```ts
 * for await (const event of runResearch("What caused the 2008 crisis?")) {
 *   console.log(event);
 * }
 * for await (const event of runResearch("Summarize my docs", "Session", { knowledgeContext: "..." })) {
 *   console.log(event);
 * }
 * ```
 */
export async function* runResearch(
  userQuery: string,
  sessionName = "Research Session",
  options: RunResearchOptions = {}
): AsyncGenerator<{ node: string; state: Partial<ResearchState> }> {
  const initialState = createInitialState({
    threadId: uuidv4(),
    userQuery,
    sessionName,
    knowledgeContext: options.knowledgeContext,
    contextUrls: options.contextUrls,
  });

  const config = {
    configurable: { thread_id: initialState.threadId },
    metadata: {
      project: process.env.LANGCHAIN_PROJECT ?? "deeptrust",
      run_name: "DeepTrust research session",
      source: "deeptrust-ui",
      ...(options.metadata ?? {}),
    },
  };

  for await (const event of await deepTrustGraph.stream(initialState, config)) {
    // LangGraph interrupts surface under the __interrupt__ key.
    if ("__interrupt__" in event) {
      const interruptInfo = (event as any).__interrupt__;
      yield {
        node: "__interrupt__",
        // Expose threadId so callers can resume the run.
        state: {
          threadId: initialState.threadId,
          interrupt: interruptInfo,
        } as any,
      };
      return;
    }

    for (const [node, state] of Object.entries(event)) {
      yield { node, state: state as Partial<ResearchState> };
    }
  }
}

/**
 * Resume a paused session after human approval.
 *
 * Uses LangGraph's Command API to provide a resume value to the
 * interrupt() call in hitlGateNode and update state in one step.
 */
export async function* approveAndResume(
  threadId: string
): AsyncGenerator<{ node: string; state: Partial<ResearchState> }> {
  const config = { configurable: { thread_id: threadId } };

  const resumeCommand = new Command({
    resume: true,
    update: { humanApproved: true } as Record<string, unknown>,
  });

  for await (const event of await deepTrustGraph.stream(resumeCommand as any, config)) {
    if ("__interrupt__" in event) {
      continue;
    }
    for (const [node, state] of Object.entries(event)) {
      yield { node, state: state as Partial<ResearchState> };
    }
  }
}
