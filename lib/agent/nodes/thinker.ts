/**
 * Thinker Node — produces or revises a structured ResearchPlan
 */

import { chatComplete } from "../llm";
import { extractJSON } from "../utils";
import { ResearchState, ResearchPlan, appendReasoning } from "../state";

/**
 * Produces (or revises) a structured ResearchPlan.
 * When `state.rejectionFeedback` is set, the model receives the
 * Auditor's critique and is instructed to produce a corrected plan.
 */
export async function thinkerNode(
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

  // Parse and validate the plan (with robust JSON extraction)
  let parsed: unknown;
  try {
    parsed = extractJSON(rawThought);
  } catch {
    throw new Error(`Thinker produced non-JSON output: ${rawThought.slice(0, 300)}`);
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
    rejectionFeedback: null,
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

