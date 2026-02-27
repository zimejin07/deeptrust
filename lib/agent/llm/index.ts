/**
 * LLM Client — Hugging Face Transformers (local inference)
 */

import { pipeline, TextGenerationPipeline, env } from "@huggingface/transformers";

// Use a persistent cache directory outside node_modules
env.cacheDir = process.env.HF_CACHE_DIR || "./.hf-cache";

export const MODEL_ID = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-360M-Instruct";

// Model state
let generatorPromise: Promise<TextGenerationPipeline> | null = null;
let isModelLoaded = false;
let currentProgress = 0;
let currentStatus = "idle";
let currentFile = "";

export interface ModelProgress {
  status: "idle" | "loading" | "downloading" | "ready" | "error";
  progress: number;
  file: string;
  message: string;
}

export function getModelStatus(): ModelProgress {
  if (isModelLoaded) {
    return { status: "ready", progress: 100, file: "", message: "Model ready" };
  }
  if (generatorPromise) {
    return { 
      status: currentStatus as ModelProgress["status"], 
      progress: currentProgress, 
      file: currentFile,
      message: currentFile ? `Downloading ${currentFile}` : "Loading model..."
    };
  }
  return { status: "idle", progress: 0, file: "", message: "Model not loaded" };
}

export type ProgressCallback = (progress: ModelProgress) => void;

export function loadModel(onProgress?: ProgressCallback): Promise<TextGenerationPipeline> {
  if (generatorPromise) {
    return generatorPromise;
  }

  console.log(`\n🔄 Loading model: ${MODEL_ID}`);
  console.log(`   Cache directory: ${env.cacheDir}\n`);

  currentStatus = "loading";
  const startTime = Date.now();

  generatorPromise = (pipeline("text-generation", MODEL_ID, {
    progress_callback: (progressData: { status: string; file?: string; progress?: number }) => {
      currentStatus = progressData.status === "progress" ? "downloading" : "loading";
      currentFile = progressData.file || "";
      currentProgress = Math.round((progressData.progress || 0) * 100);

      const update: ModelProgress = {
        status: currentStatus as ModelProgress["status"],
        progress: currentProgress,
        file: currentFile,
        message: currentFile 
          ? `Downloading ${currentFile.split("/").pop()} (${currentProgress}%)`
          : `${progressData.status}...`
      };

      console.log(`   ${update.message}`);
      onProgress?.(update);
    },
  }) as Promise<TextGenerationPipeline>)
    .then((gen) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n✅ Model loaded in ${elapsed}s\n`);
      isModelLoaded = true;
      currentStatus = "ready";
      currentProgress = 100;
      onProgress?.({ status: "ready", progress: 100, file: "", message: "Model ready" });
      return gen;
    })
    .catch((err) => {
      currentStatus = "error";
      generatorPromise = null;
      onProgress?.({ status: "error", progress: 0, file: "", message: err.message });
      throw err;
    });

  return generatorPromise;
}

function getGenerator(): Promise<TextGenerationPipeline> {
  return loadModel();
}

/**
 * Send a chat completion request to the local LLM.
 */
export async function chatComplete(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const generator = await getGenerator();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const preview = userMessage.slice(0, 60).replace(/\n/g, " ");
  console.log(`🤖 Generating response for: "${preview}..."`);
  const startTime = Date.now();

  const output = await generator(messages, {
    max_new_tokens: 4096,
    do_sample: true,
    temperature: 0.7,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const result = output[0] as { generated_text: Array<{ role: string; content: string }> };
  const assistantMessage = result.generated_text.find(
    (msg) => msg.role === "assistant"
  );

  if (!assistantMessage) {
    throw new Error("No assistant response generated");
  }

  console.log(`✅ Generated ${assistantMessage.content.length} chars in ${elapsed}s`);
  return assistantMessage.content;
}

