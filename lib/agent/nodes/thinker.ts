/**
 * Thinker Node — produces or revises a structured ResearchPlan
 *
 * Uses safeParse + retry with Zod error feedback so that invalid LLM output
 * (e.g. missing fields, wrong types) is corrected by the model instead of
 * causing a 500. After max retries, throws so the route can stream an error event.
 */

import { chatComplete } from "../llm";
import { extractJSON } from "../utils";
import { ResearchState, ResearchPlan, appendReasoning } from "../state";

const MAX_PLAN_ATTEMPTS = 3;

/**
 * Format Zod errors for inclusion in the next prompt so the LLM can self-correct.
 */
function formatZodErrors(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
}

/**
 * Produces (or revises) a structured ResearchPlan.
 * When `state.rejectionFeedback` is set, the model receives the
 * Auditor's critique and is instructed to produce a corrected plan.
 *
 * If the LLM returns invalid JSON or fails schema validation, we retry up to
 * MAX_PLAN_ATTEMPTS times, feeding the validation errors back into the prompt.
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

  let revisionContext = isRevision
    ? `\n\nPREVIOUS PLAN WAS REJECTED. Auditor feedback:\n${state.rejectionFeedback}\n\nRevision #${state.planRevisionCount + 1}: Produce a corrected plan.`
    : "";

  let userMessage = `Research question: "${state.userQuery}"${revisionContext}`;

  let lastRawThought: string | null = null;
  let lastParseError: string | null = null;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const parseFeedback =
      lastParseError &&
      `\n\nYour previous response had validation errors. Fix them and return ONLY valid JSON:\n${lastParseError}`;

    const rawThought = await chatComplete(
      system,
      userMessage + (parseFeedback ?? "")
    );
    lastRawThought = rawThought;

    let parsed: unknown;
    try {
      parsed = extractJSON(rawThought);
    } catch {
      lastParseError = `Could not parse as JSON. Output started with: ${rawThought.slice(0, 200)}`;
      continue;
    }

    const withRevision = {
      ...(parsed as object),
      revision: state.planRevisionCount,
    };

    const result = ResearchPlan.safeParse(withRevision);
    if (result.success) {
      const plan = result.data;
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

    lastParseError = formatZodErrors(result.error.issues);
  }

  throw new Error(
    `Thinker failed to produce a valid plan after ${MAX_PLAN_ATTEMPTS} attempts. Last validation errors:\n${lastParseError ?? "unknown"}\n\nLast output (excerpt): ${(lastRawThought ?? "").slice(0, 400)}`
  );
}

