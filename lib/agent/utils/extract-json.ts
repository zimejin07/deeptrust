/**
 * JSON extraction helper — handles models that add extra text
 */

/**
 * Small models often emit JSON object *contents* without `{` / `}`.
 * Strip a trailing comma before wrapping so `{"a":1,}` is not produced.
 */
function tryParseBraceWrappedObjectBody(text: string): unknown | null {
  const trimmed = text.trim();
  let candidate = trimmed;
  if (!candidate.startsWith('"')) {
    const q = candidate.indexOf('"');
    if (q === -1) return null;
    candidate = candidate.slice(q);
  }
  if (!candidate.includes(":")) return null;
  const inner = candidate.replace(/,\s*$/, "").trim();
  if (!inner.startsWith('"')) return null;
  try {
    return JSON.parse(`{${inner}}`);
  } catch {
    return null;
  }
}

/**
 * Extracts JSON from model output that may contain extra text,
 * markdown fences, or other non-JSON content.
 */
export function extractJSON(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to extraction methods
  }

  // Remove markdown code fences
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  // Try to find JSON object boundaries
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Continue
    }
  }

  // Try to find JSON array boundaries
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      // Continue
    }
  }

  // Braceless object body, e.g. `"verdict": "needs_revision"`
  const fromCleaned = tryParseBraceWrappedObjectBody(cleaned);
  if (fromCleaned !== null) return fromCleaned;

  const fromOriginal = tryParseBraceWrappedObjectBody(text);
  if (fromOriginal !== null) return fromOriginal;

  throw new Error(`Could not extract valid JSON from: ${text.slice(0, 200)}...`);
}
