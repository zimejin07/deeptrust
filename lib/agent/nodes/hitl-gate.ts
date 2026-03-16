/**
 * HITL Gate Node — Human-in-the-Loop interrupt point
 */

import { interrupt } from "@langchain/langgraph";
import { ResearchState, appendReasoning } from "../state";

/**
 * Pauses the graph and surfaces the plan to the operator.
 * When the graph is resumed (via .updateState()), the caller
 * must set `state.humanApproved = true` to proceed.
 *
 * Using LangGraph's `interrupt()` primitive ensures the
 * checkpoint is written BEFORE the interrupt fires, so the
 * session can be resumed from any client or process.
 */
export async function hitlGateNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  const reasoning = appendReasoning(state, {
    node: "thinker", // logged under thinker namespace for UI grouping
    summary: "⏸ HITL gate: awaiting human approval before tool execution.",
  });

  // This call writes a checkpoint and suspends until the graph
  // is resumed externally. The value passed to interrupt() is
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

