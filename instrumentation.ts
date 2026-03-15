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
  console.log(`[instrumentation] Preloading model in background: ${modelId}`);
  void loadModel(undefined, "q4")
    .then(() => console.log("[instrumentation] Model preload complete."))
    .catch((err) =>
      console.error("[instrumentation] Model preload failed:", err instanceof Error ? err.message : err)
    );
}
