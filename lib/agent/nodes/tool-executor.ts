/**
 * Tool Executor Node — executes research plan steps
 */

import { ResearchState, ResearchPlan, ResearchStep, appendReasoning } from "../state";

/**
 * Executes one step at a time (the step at `currentStepIndex`).
 * After each execution the graph loops back through the router;
 * when all steps are complete it advances to synthesizer.
 *
 * Real tool integrations (Tavily, Playwright, etc.) replace the
 * stub `dispatchTool` function.
 */
export async function toolExecutorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) throw new Error("toolExecutorNode called with no plan");

  const step = state.plan.steps[state.currentStepIndex];
  if (!step) throw new Error(`No step at index ${state.currentStepIndex}`);

  // Dispatch the tool
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

/**
 * Dispatch a tool call. Replace stubs with real implementations.
 */
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

