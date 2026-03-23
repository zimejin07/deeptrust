/**
 * Auditor Node — validates plans against organizational policy
 */

import { chatComplete } from "../llm";
import { extractJSON, loadPolicy } from "../utils";
import { ResearchState, AuditResult, appendReasoning } from "../state";

const MAX_AUDITOR_ATTEMPTS = 3;

const VERDICT_REGEX = /"verdict"\s*:\s*"(approved|rejected|needs_revision)"/;

/**
 * Format Zod errors for inclusion in the next prompt so the LLM can self-correct.
 */
function formatZodErrors(issues: { path: unknown[]; message: string }[]): string {
  return issues
    .map((i) => `  - ${i.path.map((p) => String(p)).join(".")}: ${i.message}`)
    .join("\n");
}

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
 * Phrases that SmolLM2 copies verbatim from the system prompt example.
 * If all policyViolations/suggestions match these, the model had no real
 * objection — treat the verdict as "approved" to break the loop.
 */
const PLACEHOLDER_PATTERNS = [
  /^<cite\b/i,
  /^<one concrete\b/i,
  /policy section.*rule that is violated/i,
  /rewrite or adjust the plan to comply/i,
  /how to rewrite or adjust/i,
];

function isPlaceholderText(s: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(s.trim()));
}

function parseAuditResult(parsed: unknown) {
  const base = parsed as Record<string, unknown>;
  const violations = normalizeStringArray(base.policyViolations);
  const suggestions = normalizeStringArray(base.suggestions);

  const allPlaceholder =
    violations.every(isPlaceholderText) && suggestions.every(isPlaceholderText);

  return AuditResult.safeParse({
    ...base,
    verdict: allPlaceholder ? "approved" : base.verdict,
    policyViolations: allPlaceholder ? [] : violations,
    suggestions: allPlaceholder ? [] : suggestions,
    auditedAt: new Date().toISOString(),
  });
}

/**
 * Last resort when JSON and retries fail: recover verdict from a substring fragment.
 */
function auditFromVerdictRegex(rawThought: string): AuditResult | null {
  const m = rawThought.match(VERDICT_REGEX);
  if (!m) return null;
  const verdict = m[1];
  const result = AuditResult.safeParse({
    verdict,
    policyViolations: [
      "Auditor output could not be parsed as full JSON; verdict was recovered from partial output.",
    ],
    suggestions: [],
    auditedAt: new Date().toISOString(),
  });
  return result.success ? result.data : null;
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

Return ONLY a valid JSON object. Use real content from POLICY above — do NOT copy placeholder text.
Example shape (placeholders must be replaced with real strings from the policy and plan):
{
  "verdict": "needs_revision",
  "policyViolations": ["<cite specific POLICY.md section or rule>"],
  "suggestions": ["<one concrete plan change>"],
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

  const userMessageBase = `
POLICY:
${policy}

PLAN TO AUDIT:
${JSON.stringify(state.plan, null, 2)}
  `.trim();

  let lastRawThought = "";
  let lastParseError: string | null = null;

  for (let attempt = 1; attempt <= MAX_AUDITOR_ATTEMPTS; attempt++) {
    const parseFeedback =
      lastParseError &&
      `\n\nYour previous response had errors. Fix them and return ONLY valid JSON:\n${lastParseError}`;

    const rawThought = await chatComplete(
      system,
      userMessageBase + (parseFeedback ?? "")
    );
    lastRawThought = rawThought;

    let parsed: unknown;
    try {
      parsed = extractJSON(rawThought);
    } catch {
      lastParseError = `Could not parse as JSON. Output started with: ${rawThought.slice(0, 200)}`;
      continue;
    }

    const zodResult = parseAuditResult(parsed);
    if (zodResult.success) {
      return buildAuditorState(state, zodResult.data, rawThought);
    }

    lastParseError = formatZodErrors(zodResult.error.issues);
  }

  const regexAudit = auditFromVerdictRegex(lastRawThought);
  if (regexAudit) {
    return buildAuditorState(state, regexAudit, lastRawThought);
  }

  throw new Error(
    `Auditor failed after ${MAX_AUDITOR_ATTEMPTS} attempts. The model did not return valid JSON matching the audit schema. ` +
      `Try a larger model or lower sampling temperature. Last output (excerpt): ${lastRawThought.slice(0, 400)}`
  );
}

function buildAuditorState(
  state: ResearchState,
  auditResult: AuditResult,
  rawThought: string
): Partial<ResearchState> {
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
