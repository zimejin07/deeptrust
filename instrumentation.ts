/**
 * Next.js instrumentation — runs once when the Node server starts.
 * Preloads the LLM model so the first request doesn't wait for download + load.
 * Skip on Vercel (no local inference). Disable with DEEPTRUST_LOAD_MODEL_AT_STARTUP=0.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VERCEL === "1") return;
  if (process.env.DEEPTRUST_LOAD_MODEL_AT_STARTUP === "0" || process.env.DEEPTRUST_LOAD_MODEL_AT_STARTUP === "false") return;

  const { loadModel } = await import("@/lib/agent/llm");
  const modelId = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-135M-Instruct";
  try {
    console.log(`[instrumentation] Preloading model: ${modelId}`);
    await loadModel(undefined, "q4");
    console.log("[instrumentation] Model preload complete.");
  } catch (err) {
    console.error("[instrumentation] Model preload failed (server will still start):", err instanceof Error ? err.message : err);
  }
}
