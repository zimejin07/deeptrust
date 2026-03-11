/**
 * LLM Client — server-side inference via a worker thread
 *
 * Pipeline runs in lib/agent/llm/worker-entry (compiled to dist/llm). This module
 * spawns the worker and proxies getModelStatus, loadModel, chatComplete so API routes
 * and the agent keep the same API. Keeps the main Node process non-blocking.
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";

import type { ModelOption, ModelProgress } from "./pipeline";

// Static list for API responses; worker also returns models in getStatus/load payloads
export type { ModelOption, ModelProgress };
export const MODEL_ID =
  process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-135M-Instruct";

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

export type ProgressCallback = (progress: ModelProgress) => void;

let worker: Worker | null = null;
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: ProgressCallback }
>();

function getWorkerPath(): string {
  return path.join(process.cwd(), "dist", "llm", "worker-entry.js");
}

function getWorker(): Worker {
  if (worker) return worker;
  const workerPath = getWorkerPath();
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `LLM worker not found at ${workerPath}. Run "npm run build:worker" (or "npm run build") first.`
    );
  }
  worker = new Worker(workerPath, {
    stdout: true,
    stderr: true,
  });
  worker.on("message", (msg: { id: string; type: string; payload: unknown }) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === "progress" && entry.onProgress) {
      entry.onProgress(msg.payload as ModelProgress);
      return;
    }
    pending.delete(msg.id);
    if (msg.type === "resolve") entry.resolve(msg.payload);
    else if (msg.type === "reject") entry.reject(new Error(String(msg.payload)));
  });
  worker.on("error", (err) => {
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      for (const [, entry] of pending) entry.reject(new Error(`Worker exited with code ${code}`));
      pending.clear();
    }
    worker = null;
  });
  return worker;
}

function send<T>(type: string, payload: unknown, onProgress?: ProgressCallback): Promise<T> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage({ id, type, payload });
  });
}

export type ModelStatusResponse = ModelProgress & { models: ModelOption[] };

export function getModelStatus(forModelId?: string, forDtype?: string): Promise<ModelStatusResponse> {
  return send<ModelStatusResponse>("getStatus", { modelId: forModelId, dtype: forDtype });
}

/** Resolves when the model is loaded; progress is reported via onProgress. */
export function loadModel(
  modelId?: string,
  dtype?: ModelOption["dtype"],
  onProgress?: ProgressCallback
): Promise<ModelStatusResponse> {
  return send<ModelStatusResponse>("load", { modelId, dtype }, onProgress);
}

export async function chatComplete(systemPrompt: string, userMessage: string): Promise<string> {
  return send<string>("chat", { systemPrompt, userMessage });
}
