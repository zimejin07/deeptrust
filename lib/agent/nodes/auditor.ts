/**
 * Auditor Node — validates plans against organizational policy
 *
 * Two-layer audit: deterministic structural checks run first (step count,
 * request budget) so the gate works even when the LLM is too small to
 * reason about policy.  The LLM audit runs second and can add violations
 * but cannot override a deterministic rejection.
 */

import { chatComplete } from "../llm";
import { extractJSON, loadPolicy } from "../utils";
import {
  ResearchState,
  ResearchPlan,
  AuditResult,
  appendReasoning,
} from "../state";

const MAX_AUDITOR_ATTEMPTS = 3;
const MAX_STEPS_PER_PLAN = 6;
const MAX_HTTP_REQUESTS_PER_SESSION = 10;

const VERDICT_REGEX = /"verdict"\s*:\s*"(approved|rejected|needs_revision)"/;

// ─── Deterministic structural checks ─────────────────────────

interface RuleCheckResult {
  violations: string[];
  suggestions: string[];
}

function checkPlanStructure(plan: ResearchPlan): RuleCheckResult {
  const violations: string[] = [];
  const suggestions: string[] = [];

  if (plan.steps.length > MAX_STEPS_PER_PLAN) {
    violations.push(
      `Plan has ${plan.steps.length} steps, exceeding the maximum of ${MAX_STEPS_PER_PLAN}.`
    );
    suggestions.push(`Reduce the plan to at most ${MAX_STEPS_PER_PLAN} steps.`);
  }

  if (plan.steps.length > MAX_HTTP_REQUESTS_PER_SESSION) {
    violations.push(
      `Plan would make ${plan.steps.length} HTTP requests, exceeding the session limit of ${MAX_HTTP_REQUESTS_PER_SESSION} (policy: "Never make more than 10 external HTTP requests per session").`
    );
    suggestions.push(`Reduce to at most ${MAX_HTTP_REQUESTS_PER_SESSION} steps.`);
  }

  const emptyInputs = plan.steps.filter((s) => !s.input.trim());
  if (emptyInputs.length > 0) {
    violations.push(`${emptyInputs.length} step(s) have empty search inputs.`);
    suggestions.push("Provide a specific search query for every step.");
  }

  return { violations, suggestions };
}

// ─── LLM-based audit helpers ─────────────────────────────────

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

const PLACEHOLDER_PATTERNS = [
  /^<cite\b/i,
  /^<one concrete\b/i,
  /^<one specific\b/i,
  /policy section.*rule that is violated/i,
  /rewrite or adjust the plan to comply/i,
  /how to rewrite or adjust/i,
  /^#?DeepTrust/i,
  /^#?Default Policy/i,
  /POLYNICELYP/i,
];

const VERDICT_VALUES = new Set(["approved", "rejected", "needs_revision"]);

function isNonsenseViolation(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed))) return true;
  if (VERDICT_VALUES.has(trimmed.toLowerCase())) return true;
  if (trimmed.length < 50 && !trimmed.includes(" ")) return true;
  if (trimmed.length < 20) return true;
  return false;
}

/**
 * Detect repetition-loop output from small models: if a short substring
 * repeats 5+ times in the raw text, the output is degenerate.
 */
function isRepetitionLoop(text: string, minRepeats = 5): boolean {
  if (text.length < 200) return false;
  const sample = text.slice(0, 2000);
  const lines = sample.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < minRepeats) return false;
  const freq = new Map<string, number>();
  for (const line of lines) {
    const key = line.slice(0, 80);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  for (const count of freq.values()) {
    if (count >= minRepeats) return true;
  }
  return false;
}

function parseAuditResult(parsed: unknown, rawThought: string) {
  const base = parsed as Record<string, unknown>;
  const violations = normalizeStringArray(base.policyViolations);
  const suggestions = normalizeStringArray(base.suggestions);

  const allPlaceholder = violations.every(isNonsenseViolation);
  const degenerate = isRepetitionLoop(rawThought);

  // When the LLM produced nonsense or degenerate output, treat as
  // "LLM audit inconclusive" — deterministic checks will still apply.
  const llmInconclusive = allPlaceholder || degenerate;

  return {
    zodResult: AuditResult.safeParse({
      ...base,
      verdict: llmInconclusive ? "approved" : base.verdict,
      policyViolations: llmInconclusive ? [] : violations,
      suggestions: llmInconclusive ? [] : suggestions,
      auditedAt: new Date().toISOString(),
    }),
    llmInconclusive,
  };
}

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

// ─── Main auditor node ───────────────────────────────────────

export async function auditorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) {
    throw new Error("auditorNode called with no plan in state");
  }

  // Layer 1: deterministic structural checks (always reliable)
  const ruleCheck = checkPlanStructure(state.plan);

  if (ruleCheck.violations.length > 0) {
    const auditResult: AuditResult = {
      verdict: "needs_revision",
      policyViolations: ruleCheck.violations,
      suggestions: ruleCheck.suggestions,
      auditedAt: new Date().toISOString(),
    };

    return buildAuditorState(
      state,
      auditResult,
      `[Deterministic audit] ${ruleCheck.violations.join("; ")}`,
      false
    );
  }

  // Layer 2: LLM-based audit (best-effort with small models)
  const policy = loadPolicy();

  const system = `
You are the Auditor node of DeepTrust.
You evaluate research plans against an organisational policy and return a structured verdict.

Return ONLY a valid JSON object (no other text). Example:
{"verdict":"approved","policyViolations":[],"suggestions":[],"auditedAt":"${new Date().toISOString()}"}

Verdict values: "approved", "rejected", "needs_revision".
If the plan complies with all policy rules, use "approved" with empty arrays.
Do not include markdown fences or any prose outside the JSON object.
  `.trim();

  const userMessageBase = `
POLICY:
${policy}

PLAN TO AUDIT:
${JSON.stringify(state.plan, null, 2)}
  `.trim();

  let lastRawThought = "";
  let lastParseError: string | null = null;
  let wasLlmInconclusive = false;

  for (let attempt = 1; attempt <= MAX_AUDITOR_ATTEMPTS; attempt++) {
    const parseFeedback =
      lastParseError &&
      `\n\nYour previous response had errors. Fix them and return ONLY valid JSON:\n${lastParseError}`;

    const rawThought = await chatComplete(
      system,
      userMessageBase + (parseFeedback ?? ""),
      { temperature: 0.3 }
    );
    lastRawThought = rawThought;

    let parsed: unknown;
    try {
      parsed = extractJSON(rawThought);
    } catch {
      lastParseError = `Could not parse as JSON. Output started with: ${rawThought.slice(0, 200)}`;
      continue;
    }

    const { zodResult, llmInconclusive } = parseAuditResult(parsed, rawThought);
    wasLlmInconclusive = llmInconclusive;
    if (zodResult.success) {
      return buildAuditorState(state, zodResult.data, rawThought, llmInconclusive);
    }

    lastParseError = formatZodErrors(zodResult.error.issues);
  }

  const regexAudit = auditFromVerdictRegex(lastRawThought);
  if (regexAudit) {
    return buildAuditorState(state, regexAudit, lastRawThought, true);
  }

  // All LLM attempts failed but deterministic checks passed — auto-approve
  // with a clear note that the LLM audit was inconclusive.
  const fallbackResult: AuditResult = {
    verdict: "approved",
    policyViolations: [],
    suggestions: [],
    auditedAt: new Date().toISOString(),
  };
  return buildAuditorState(
    state,
    fallbackResult,
    `[LLM audit failed after ${MAX_AUDITOR_ATTEMPTS} attempts; approved by deterministic checks only] ${lastRawThought.slice(0, 300)}`,
    true
  );
}

function buildAuditorState(
  state: ResearchState,
  auditResult: AuditResult,
  rawThought: string,
  llmInconclusive: boolean
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

  let summary: string;
  if (isRejected) {
    summary = `Plan REJECTED (${auditResult.verdict}). ${auditResult.policyViolations.length} violation(s) found.`;
  } else if (llmInconclusive) {
    summary = "Plan APPROVED (deterministic checks only — LLM audit was inconclusive).";
  } else {
    summary = "Plan APPROVED — no policy violations detected.";
  }

  const reasoning = appendReasoning(state, {
    node: "auditor",
    summary,
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
