/**
 * Next.js instrumentation — runs once when the Node server starts.
 * Preloads the LLM model so the first request doesn't wait for download + load.
 * Skip on Vercel (no local inference). Disable with DEEPTRUST_LOAD_MODEL_AT_STARTUP=0.
 * Skip on Hugging Face Spaces so the Space becomes healthy immediately (model loads on first use).
 *
 * Logs progress from the worker so long-running downloads/loads are visible in Space logs.
 * After PRELOAD_TIMEOUT_MS (default 10 min) logs a timeout message if still loading.
 */

const PRELOAD_TIMEOUT_MS = Number(process.env.DEEPTRUST_PRELOAD_TIMEOUT_MS) || 10 * 60 * 1000;

/** True when running inside a Hugging Face Space (avoids startup preload so health check passes). */
function isHuggingFaceSpace(): boolean {
  if (process.env.SPACE_ID || process.env.HF_SPACE_ID) return true;
  if (process.env.PORT === "7860") return true; // Spaces default Docker app_port
  return false;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VERCEL === "1") return;
  if (process.env.DEEPTRUST_LOAD_MODEL_AT_STARTUP === "0" || process.env.DEEPTRUST_LOAD_MODEL_AT_STARTUP === "false") return;
  if (isHuggingFaceSpace()) {
    console.log("[instrumentation] Hugging Face Space detected; skipping startup model preload (model will load on first use).");
    return;
  }

  const { loadModel } = await import("@/lib/agent/llm");
  const modelId = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-135M-Instruct";
  console.log(`[instrumentation] Preloading model in background: ${modelId}`);

  let completed = false;
  const timeoutId = setTimeout(() => {
    if (!completed) {
      console.log(
        `[instrumentation] Model preload still in progress (timeout after ${PRELOAD_TIMEOUT_MS / 60000} min). Check worker logs for download/load progress.`
      );
    }
  }, PRELOAD_TIMEOUT_MS);

  const onProgress = (p: { status: string; message: string; file?: string; progress?: number }) => {
    console.log(`[instrumentation] ${p.message}${p.progress != null ? ` ${p.progress}%` : ""}`);
  };

  void loadModel(undefined, "q4", onProgress)
    .then(() => {
      completed = true;
      console.log("[instrumentation] Model preload complete.");
    })
    .catch((err) => {
      completed = true;
      console.error("[instrumentation] Model preload failed:", err instanceof Error ? err.message : err);
    })
    .finally(() => clearTimeout(timeoutId));
}
