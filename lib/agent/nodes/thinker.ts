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
/** Cap retry feedback so small models do not echo nested "Could not parse..." chains forever. */
const MAX_PARSE_FEEDBACK_LEN = 1200;

/**
 * Shorten and de-duplicate nested JSON parse error text before the next LLM turn.
 */
function sanitizeParseFeedback(text: string): string {
  let s = text;
  while (
    s.includes("Could not parse as JSON. Output started with: Could not parse as JSON. Output started with:")
  ) {
    s = s.replace(
      /Could not parse as JSON\. Output started with: Could not parse as JSON\. Output started with: /g,
      "Could not parse as JSON. Output started with: "
    );
  }
  if (s.length <= MAX_PARSE_FEEDBACK_LEN) return s;
  return `${s.slice(0, MAX_PARSE_FEEDBACK_LEN)}\n…(truncated)`;
}

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
      tool: "web_search",
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

  const escapedQuery = state.userQuery.replace(/"/g, '\\"');

  const system = `
You are the Thinker node of DeepTrust, an autonomous research agent.
Decompose a research question into a step-by-step web search plan.

Return ONLY a valid JSON object (no extra text). Fill in real values — do NOT copy the placeholders.
Example structure:
{
  "objective": "${escapedQuery}",
  "steps": [
    {"id": "1", "tool": "web_search", "input": "${escapedQuery}", "rationale": "Search for information about the topic"}
  ],
  "estimatedTokenBudget": 2048,
  "createdAt": "${new Date().toISOString()}",
  "revision": 0
}

Rules:
- "objective" must describe the actual research goal, not a placeholder.
- Every step "input" must be a specific search query about the topic. Never use generic text like "search query".
- Every step must use "tool": "web_search". No other tools exist.
- Maximum 6 steps.
- Do not include markdown fences or any prose outside the JSON.
  `.trim();

  let revisionContext = isRevision
    ? `\n\nPREVIOUS PLAN WAS REJECTED. Auditor feedback:\n${state.rejectionFeedback}\n\nRevision #${state.planRevisionCount + 1}: Produce a corrected plan.`
    : "";

  let knowledgeBlock = "";
  if (state.knowledgeContext?.trim()) {
    knowledgeBlock = `\n\nThe user provided the following retrieved context from their local knowledge base. Use it to inform the plan and prefer steps that leverage this context where relevant:\n\n${state.knowledgeContext}`;
  }
  if (state.contextUrls?.length) {
    knowledgeBlock += `\n\nThe user also referenced these URLs: ${state.contextUrls.join(", ")}`;
  }

  let userMessage = `Research question: "${state.userQuery}"${revisionContext}${knowledgeBlock}`;

  let lastRawThought: string | null = null;
  let lastParseError: string | null = null;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const parseFeedback =
      lastParseError &&
      `\n\nYour previous response had validation errors. Fix them and return ONLY valid JSON:\n${sanitizeParseFeedback(lastParseError)}`;

    const rawThought = await chatComplete(
      system,
      userMessage + (parseFeedback ?? "")
    );
    lastRawThought = rawThought;

    let parsed: unknown;
    try {
      parsed = extractJSON(rawThought);
    } catch {
      lastParseError = sanitizeParseFeedback(
        `Could not parse as JSON. First 200 chars of model output:\n${rawThought.slice(0, 200)}`
      );
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

    lastParseError = sanitizeParseFeedback(formatZodErrors(result.error.issues));
  }

  // Fallback: if the model failed to produce valid JSON after all attempts,
  // synthesize a minimal but valid single-step plan directly from the user query
  // so the run can still proceed instead of hard-failing.
  const fallbackPlanResult = ResearchPlan.safeParse({
    objective:
      typeof state.userQuery === "string" && state.userQuery.trim().length > 0
        ? state.userQuery.trim()
        : "Research objective",
    steps: [
      {
        id: uuidv4(),
        tool: "web_search",
        input:
          typeof state.userQuery === "string" && state.userQuery.trim().length > 0
            ? state.userQuery.trim()
            : "Initial research query",
        rationale: "Initial search to gather information on the research question.",
      },
    ],
    estimatedTokenBudget: 2048,
    createdAt: new Date().toISOString(),
    revision: state.planRevisionCount,
  });

  if (fallbackPlanResult.success) {
    const plan = fallbackPlanResult.data;
    const reasoning = appendReasoning(state, {
      node: "thinker",
      summary: `Fallback plan created after ${MAX_PLAN_ATTEMPTS} failed JSON attempts: ${plan.steps.length} step for "${plan.objective}"`,
      rawThought: lastRawThought ?? undefined,
    });

    return {
      plan,
      status: "thinking",
      rejectionFeedback: null,
      reasoning,
      updatedAt: new Date().toISOString(),
    };
  }

  throw new Error(
    `Thinker failed to produce a valid plan after ${MAX_PLAN_ATTEMPTS} attempts. Last validation errors:\n${lastParseError ?? "unknown"}\n\nLast output (excerpt): ${(lastRawThought ?? "").slice(0, 400)}`
  );
}

