/**
 * Tool Executor Node — executes research plan steps
 */

import { ResearchState, ResearchPlan, ResearchStep, appendReasoning } from "../state";

/**
 * Executes one step at a time (the step at `currentStepIndex`).
 * After each execution the graph loops back through the router;
 * when all steps are complete it advances to synthesizer.
 */
export async function toolExecutorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) throw new Error("toolExecutorNode called with no plan");

  const step = state.plan.steps[state.currentStepIndex];
  if (!step) throw new Error(`No step at index ${state.currentStepIndex}`);

  const output = await dispatchTool(step.tool, step.input);

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

async function dispatchTool(
  tool: ResearchStep["tool"],
  input: string
): Promise<string> {
  switch (tool) {
    case "web_search":
      // TODO: replace with real search (e.g. Tavily, SearXNG)
      return `[STUB] web_search result for: "${input}"`;
    default: {
      const _exhaustive: never = tool;
      throw new Error(`Unknown tool: ${_exhaustive}`);
    }
  }
}
