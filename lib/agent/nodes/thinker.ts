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
import { v4 as uuidv4 } from "uuid";

const MAX_PLAN_ATTEMPTS = 3;

/**
 * Format Zod errors for inclusion in the next prompt so the LLM can self-correct.
 */
function formatZodErrors(issues: { path: unknown[]; message: string }[]): string {
  return issues
    .map((i) => `  - ${i.path.map((p) => String(p)).join(".")}: ${i.message}`)
    .join("\n");
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalize LLM output so it passes ResearchPlan: fix non-UUID step ids and
 * missing rationales (small/local models often omit these).
 */
function normalizePlan(raw: Record<string, unknown>): Record<string, unknown> {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const normalizedSteps = steps.map((s: unknown, i: number) => {
    const step = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
    const id =
      typeof step.id === "string" && UUID_REGEX.test(step.id) ? step.id : uuidv4();
    const rationale =
      typeof step.rationale === "string" && step.rationale.length > 0
        ? step.rationale
        : typeof step.input === "string"
          ? step.input
          : `Step ${i + 1}`;
    return {
      ...step,
      id,
      rationale,
      input: typeof step.input === "string" ? step.input : "",
      tool: step.tool ?? "web_search",
    };
  });

  const createdAt =
    typeof raw.createdAt === "string" && raw.createdAt.length > 0
      ? raw.createdAt
      : new Date().toISOString();
  const estimatedTokenBudget =
    typeof raw.estimatedTokenBudget === "number" && raw.estimatedTokenBudget > 0
      ? raw.estimatedTokenBudget
      : 2048;

  const objective =
    typeof raw.objective === "string" && raw.objective.trim().length > 0
      ? raw.objective.trim()
      : "Research objective";

  return {
    ...raw,
    objective,
    steps: normalizedSteps,
    createdAt,
    estimatedTokenBudget,
  };
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

    const normalized = normalizePlan(
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
    );
    const withRevision = {
      ...normalized,
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

