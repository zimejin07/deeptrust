/**
 * DeepTrust Research Agent — Public API
 */

// Graph and public functions
export {
  buildDeepTrustGraph,
  deepTrustGraph,
  runResearch,
  approveAndResume,
} from "./graph";

// State types and helpers
export {
  ResearchState,
  ResearchPlan,
  ResearchStep,
  AuditResult,
  ReasoningEntry,
  NodeName,
  createInitialState,
  appendReasoning,
} from "./state";

// LLM client (for advanced usage)
export { chatComplete } from "./llm";

// Utilities
export { extractJSON, loadPolicy } from "./utils";

