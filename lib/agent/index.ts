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
export { chatComplete, loadModel, getModelStatus, MODEL_ID } from "./llm";
export type { ModelProgress, ProgressCallback } from "./llm";

// Utilities
export { extractJSON, loadPolicy } from "./utils";

