/**
 * Routing functions — conditional edges for the state graph
 */

import { END } from "@langchain/langgraph";
import { ResearchState } from "./state";

/**
 * After auditor: loop back to thinker or advance to HITL gate.
 */
export function routeAfterAudit(
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

/**
 * After HITL gate: block until human approves, then execute.
 */
export function routeAfterHitl(
  state: ResearchState
): "tool_executor" | typeof END {
  if (!state.humanApproved) {
    // Graph should not reach here without approval; fail safe.
    return END;
  }
  return "tool_executor";
}

/**
 * After each tool step: keep executing or move to synthesizer.
 */
export function routeAfterToolStep(
  state: ResearchState
): "tool_executor" | "synthesizer" {
  const totalSteps = state.plan?.steps.length ?? 0;
  if (state.currentStepIndex < totalSteps) {
    return "tool_executor";
  }
  return "synthesizer";
}

