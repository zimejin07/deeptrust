/**
 * Pipeline — runs inside the LLM worker thread only.
 * Hugging Face Transformers + onnxruntime-node; state lives in this thread.
 */

import { pipeline, TextGenerationPipeline, env } from "@huggingface/transformers";
import path from "node:path";

env.cacheDir =
  process.env.HF_CACHE_DIR ||
  path.join(process.cwd(), ".hf-cache");

// Default to a very small instruct model for low-spec machines.
// If this model ID does not exist or you prefer another tiny model,
// set HF_MODEL in your environment to override.
export const MODEL_ID =
  process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-135M-Instruct";

export interface ModelOption {
  id: string;
  label: string;
  dtype?: "q4" | "fp16" | "fp32";
  sizeNote?: string;
}

export const MODELS: ModelOption[] = [
  {
    id: "HuggingFaceTB/SmolLM2-135M-Instruct",
    label: "SmolLM2 135M (Q4, tiny)",
    dtype: "q4",
    sizeNote: "~150–200 MB (approx)",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    label: "SmolLM2 360M (Q4)",
    dtype: "q4",
    sizeNote: "~388 MB",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    label: "SmolLM2 360M (FP16)",
    dtype: "fp16",
    sizeNote: "~725 MB",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    label: "SmolLM2 360M (full)",
    dtype: "fp32",
    sizeNote: "~1.45 GB",
  },
];

let currentModelId = MODELS[0].id;
let currentDtype = MODELS[0].dtype;
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
  modelId?: string;
  dtype?: string;
}

export function getModelStatus(forModelId?: string, forDtype?: string): ModelProgress {
  const isOther = forModelId !== undefined && (forModelId !== currentModelId || forDtype !== currentDtype);
  if (isOther) {
    return {
      status: "idle",
      progress: 0,
      file: "",
      message: "Model not loaded",
      modelId: forModelId,
      dtype: forDtype,
    };
  }
  if (isModelLoaded) {
    return {
      status: "ready",
      progress: 100,
      file: "",
      message: "Model ready",
      modelId: currentModelId,
      dtype: currentDtype,
    };
  }
  if (generatorPromise) {
    return {
      status: currentStatus as ModelProgress["status"],
      progress: currentProgress,
      file: currentFile,
      message: currentFile ? `Downloading ${currentFile}` : "Loading model...",
      modelId: currentModelId,
      dtype: currentDtype,
    };
  }
  return {
    status: "idle",
    progress: 0,
    file: "",
    message: "Model not loaded",
    modelId: currentModelId,
    dtype: currentDtype,
  };
}

export type ProgressCallback = (progress: ModelProgress) => void;

export function loadModel(
  modelId?: string,
  dtype?: ModelOption["dtype"],
  onProgress?: ProgressCallback
): Promise<TextGenerationPipeline> {
  const nextId = modelId ?? currentModelId;
  const nextDtype = dtype ?? currentDtype;

  if (nextId !== currentModelId || nextDtype !== currentDtype) {
    generatorPromise = null;
    isModelLoaded = false;
    currentModelId = nextId;
    currentDtype = nextDtype;
    currentStatus = "idle";
    currentProgress = 0;
    currentFile = "";
  }

  if (generatorPromise) {
    return generatorPromise;
  }

  console.log(`\n🔄 [worker] Loading model: ${currentModelId}${currentDtype ? ` (${currentDtype})` : ""}`);
  console.log(`   Cache directory: ${env.cacheDir}\n`);

  currentStatus = "loading";
  const startTime = Date.now();

  const pipelineOptions: Parameters<typeof pipeline>[2] = {
    progress_callback: (progressData: {
      status: string;
      name?: string;
      file?: string;
      loaded?: number;
      total?: number;
      progress?: number;
    }) => {
      currentStatus = progressData.status === "progress" ? "downloading" : "loading";
      currentFile = progressData.file || progressData.name || "";
      currentProgress = Math.round(progressData.progress ?? 0);

      const update: ModelProgress = {
        status: currentStatus as ModelProgress["status"],
        progress: currentProgress,
        file: currentFile,
        message: currentFile
          ? `Downloading ${currentFile.split("/").pop()} (${currentProgress}%)`
          : `${progressData.status}...`,
        modelId: currentModelId,
        dtype: currentDtype,
      };

      console.log(`   ${update.message}`);
      onProgress?.(update);
    },
  };
  if (currentDtype) {
    (pipelineOptions as Record<string, unknown>).dtype = currentDtype;
  }

  const pipelinePromise = pipeline("text-generation", currentModelId, pipelineOptions);
  generatorPromise = (pipelinePromise as Promise<TextGenerationPipeline>)
    .then((gen) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n✅ [worker] Model loaded in ${elapsed}s\n`);
      isModelLoaded = true;
      currentStatus = "ready";
      currentProgress = 100;
      onProgress?.({
        status: "ready",
        progress: 100,
        file: "",
        message: "Model ready",
        modelId: currentModelId,
        dtype: currentDtype,
      });
      return gen;
    })
    .catch((err) => {
      currentStatus = "error";
      generatorPromise = null;
      onProgress?.({
        status: "error",
        progress: 0,
        file: "",
        message: err.message,
        modelId: currentModelId,
        dtype: currentDtype,
      });
      throw err;
    });

  return generatorPromise;
}

export async function chatComplete(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const generator = await loadModel();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const preview = userMessage.slice(0, 60).replace(/\n/g, " ");
  console.log(`🤖 [worker] Generating response for: "${preview}..."`);
  const startTime = Date.now();

  const output = await generator(messages, {
    max_new_tokens: 1024,
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

  console.log(`✅ [worker] Generated ${assistantMessage.content.length} chars in ${elapsed}s`);
  return assistantMessage.content;
}
