/**
 * JSON extraction helper — handles models that add extra text
 */

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

  throw new Error(`Could not extract valid JSON from: ${text.slice(0, 200)}...`);
}

