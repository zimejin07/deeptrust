/**
 * Auditor Node — validates plans against organizational policy
 */

import { chatComplete } from "../llm";
import { extractJSON, loadPolicy } from "../utils";
import { ResearchState, AuditResult, appendReasoning } from "../state";

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.reason === "string") return obj.reason;
      if (typeof obj.message === "string") return obj.message;
      return JSON.stringify(obj);
    }
    return String(item);
  });
}

/**
 * Compares the current plan against POLICY.md.
 * Sets `auditResult` with verdict + structured feedback.
 * If rejected, also sets `rejectionFeedback` and increments
 * `planRevisionCount` so the router can loop back to thinker.
 */
export async function auditorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) {
    throw new Error("auditorNode called with no plan in state");
  }

  const policy = loadPolicy();

  const system = `
You are the Auditor node of DeepTrust.
You evaluate research plans against an organisational policy and return a structured verdict.

Return ONLY a valid JSON object, for example:
{
  "verdict": "needs_revision",
  "policyViolations": ["policy section / rule that is violated"],
  "suggestions": ["how to rewrite or adjust the plan to comply"],
  "auditedAt": "2025-01-01T00:00:00.000Z"
}

Field rules:
- "verdict" must be one of: "approved", "rejected", "needs_revision".
- "policyViolations" is an array of human-readable strings that reference specific policy rules.
- "suggestions" is an array of concrete rewrite suggestions for making the plan compliant.
- "auditedAt" must be an ISO 8601 timestamp string.

Global rules:
- "approved" means the plan fully complies with policy.
- "rejected" means the plan has hard violations that cannot be patched.
- "needs_revision" means soft issues exist but the plan is salvageable.
- Treat "needs_revision" as rejection for routing purposes.
- Do not include markdown fences or any prose outside the JSON object.
  `.trim();

  const userMessage = `
POLICY:
${policy}

PLAN TO AUDIT:
${JSON.stringify(state.plan, null, 2)}
  `.trim();

  const rawThought = await chatComplete(system, userMessage);

  let parsed: unknown;
  try {
    parsed = extractJSON(rawThought);
  } catch {
    throw new Error(`Auditor produced non-JSON output: ${rawThought.slice(0, 300)}`);
  }

  const base = parsed as Record<string, unknown>;
  const auditResult = AuditResult.parse({
    ...base,
    policyViolations: normalizeStringArray(base.policyViolations),
    suggestions: normalizeStringArray(base.suggestions),
    auditedAt: new Date().toISOString(),
  });

  const isRejected = auditResult.verdict !== "approved";

  const rejectionFeedback: string | null = isRejected
    ? [
        `Verdict: ${auditResult.verdict}`,
        auditResult.policyViolations.length
          ? `Violations:\n${auditResult.policyViolations.map((v) => `  - ${v}`).join("\n")}`
          : null,
        auditResult.suggestions.length
          ? `Suggestions:\n${auditResult.suggestions.map((s) => `  - ${s}`).join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n")
    : null;

  const reasoning = appendReasoning(state, {
    node: "auditor",
    summary: isRejected
      ? `Plan REJECTED (${auditResult.verdict}). ${auditResult.policyViolations.length} violation(s) found.`
      : "Plan APPROVED — no policy violations detected.",
    rawThought,
  });

  return {
    auditResult,
    rejectionFeedback,
    planRevisionCount: isRejected
      ? state.planRevisionCount + 1
      : state.planRevisionCount,
    status: isRejected ? "thinking" : "awaiting_approval",
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

