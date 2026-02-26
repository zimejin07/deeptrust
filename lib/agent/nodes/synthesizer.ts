/**
 * Synthesizer Node — produces the final research report
 */

import { chatComplete } from "../llm";
import { ResearchState, appendReasoning } from "../state";

/**
 * Reads all step outputs and produces the final research report.
 */
export async function synthesizerNode(
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

