/**
 * Synthesizer Node — produces the final research report
 *
 * Grounding-aware: if no step produced usable results the synthesizer
 * emits an honest "insufficient data" report instead of asking the LLM
 * to hallucinate findings from nothing.
 */

import { chatComplete } from "../llm";
import { ResearchState, ResearchStep, appendReasoning } from "../state";

const NO_RESULT_MARKERS = [
  "no results found",
  "(no output)",
  "no relevant results",
  "could not find",
  "0 results",
];

function stepHasResults(step: ResearchStep): boolean {
  const output = (step.output ?? "").trim().toLowerCase();
  if (!output) return false;
  return !NO_RESULT_MARKERS.some((marker) => output.includes(marker));
}

function buildInsufficientDataReport(
  objective: string,
  steps: ResearchStep[]
): string {
  const queriesTried = steps
    .map((s, i) => `  ${i + 1}. "${s.input}"`)
    .join("\n");

  return [
    `# Research Report: ${objective}`,
    "",
    "## Result",
    "",
    "**No actionable findings.** All search queries returned zero results.",
    "",
    "## Queries attempted",
    "",
    queriesTried,
    "",
    "## Recommendations",
    "",
    "- Verify internet connectivity and search-engine availability.",
    "- Try rephrasing the research question with different keywords.",
    "- Break broad questions into narrower, more specific queries.",
    "- Check whether a search-engine API key is configured (Google CSE).",
  ].join("\n");
}

export async function synthesizerNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) throw new Error("synthesizerNode called with no plan");

  const stepsWithResults = state.plan.steps.filter(stepHasResults);
  const totalSteps = state.plan.steps.length;

  // All steps empty → deterministic report, skip the LLM entirely
  if (stepsWithResults.length === 0) {
    const finalReport = buildInsufficientDataReport(
      state.plan.objective,
      state.plan.steps
    );

    const reasoning = appendReasoning(state, {
      node: "synthesizer",
      summary: `No search results available (0/${totalSteps} steps produced data). Generated insufficient-data report.`,
    });

    return {
      finalReport,
      status: "complete",
      reasoning,
      updatedAt: new Date().toISOString(),
    };
  }

  const groundingRule =
    stepsWithResults.length < totalSteps
      ? `\n- ${totalSteps - stepsWithResults.length} of ${totalSteps} steps returned no results. Only report on findings from steps that DID return data. Do NOT invent, assume, or hallucinate information for steps that returned "No results found".`
      : "";

  const system = `
You are the Synthesizer node of DeepTrust.
You receive a research plan with all step outputs filled in,
and you write a comprehensive, well-structured research report.

Guidelines:
- Lead with an executive summary.
- Organise findings by theme, not by tool execution order.
- Cite which step produced each finding.
- End with actionable conclusions.
- ONLY report information that appears verbatim in the step outputs below. Never fabricate sources, statistics, or claims.${groundingRule}
  `.trim();

  const stepsContext = state.plan.steps
    .map(
      (s, i) =>
        `Step ${i + 1} [${s.tool}] — "${s.input}"\nOutput: ${s.output ?? "(no output)"}`
    )
    .join("\n\n---\n\n");

  const knowledgeBlock =
    state.knowledgeContext?.trim() ?
      `

User's local knowledge (use to ground or cite the report where relevant):
${state.knowledgeContext}
`
    : "";

  const userMessage = `
Objective: ${state.plan.objective}

Research results:
${stepsContext}
${knowledgeBlock}
  `.trim();

  const finalReport = await chatComplete(system, userMessage);

  const reasoning = appendReasoning(state, {
    node: "synthesizer",
    summary: `Final report synthesized from ${stepsWithResults.length}/${totalSteps} steps with data (${finalReport.length} chars).`,
  });

  return {
    finalReport,
    status: "complete",
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

