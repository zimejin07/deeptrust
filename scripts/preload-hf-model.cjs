/**
 * Pre-download the default HF model during Docker build so the container
 * doesn't need to download at runtime. Run in builder stage with:
 *   HF_CACHE_DIR=/app/.hf-cache-build node scripts/preload-hf-model.cjs
 */
const cacheDir = process.env.HF_CACHE_DIR || "/app/.hf-cache-build";
process.env.HF_CACHE_DIR = cacheDir;

const modelId = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-135M-Instruct";

async function main() {
  console.log("[preload] Downloading model:", modelId, "to", cacheDir);
  const { pipeline, env } = require("@huggingface/transformers");
  env.cacheDir = cacheDir;
  await pipeline("text-generation", modelId, {
    dtype: "q4",
    progress_callback: (d) => {
      if (d.file) process.stdout.write(`  ${d.file} ${Math.round((d.progress || 0) * 100)}%\n`);
    },
  });
  console.log("[preload] Done.");
}

main().catch((err) => {
  console.error("[preload] Failed:", err.message);
  process.exit(1);
});
