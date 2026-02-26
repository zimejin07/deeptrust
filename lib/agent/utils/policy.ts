/**
 * Policy loader — reads POLICY.md for the Auditor node
 */

import { readFileSync } from "fs";
import { join } from "path";

const DEFAULT_POLICY = `
# DeepTrust Default Policy
- Never access personal, private, or confidential data sources.
- Never execute code that modifies the host filesystem.
- Never make more than 10 external HTTP requests per session.
- Research must be directly related to the user's stated objective.
- All sources must be attributable and verifiable.
`.trim();

/**
 * Load the policy from POLICY.md or return a default fallback.
 */
export function loadPolicy(): string {
  try {
    return readFileSync(join(process.cwd(), "POLICY.md"), "utf-8");
  } catch {
    return DEFAULT_POLICY;
  }
}

