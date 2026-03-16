/**
 * Browser-side embeddings via @xenova/transformers.
 * Lazy-loads the pipeline on first use.
 */

const MODEL = "Xenova/all-MiniLM-L6-v2";

let pipelinePromise: Promise<unknown> | null = null;

async function getPipeline(): Promise<unknown> {
  if (typeof window === "undefined") {
    throw new Error("Embeddings are only available in the browser");
  }
  if (!pipelinePromise) {
    const { pipeline } = await import("@xenova/transformers");
    pipelinePromise = pipeline("feature-extraction", MODEL);
  }
  return pipelinePromise;
}

/** Embed a single text. Returns normalized vector for cosine similarity. */
export async function embed(text: string): Promise<number[]> {
  const pipe = (await getPipeline()) as (input: string, options?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array }>;
  const output = await pipe(text, { pooling: "mean", normalize: true });
  const data = output.data;
  if (!data) throw new Error("Embedding output has no data");
  return Array.from(data);
}

/** Embed multiple texts in one batch (more efficient). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = (await getPipeline()) as (input: string | string[], options?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  const data = output.data;
  const dims = output.dims;
  if (!data || !dims?.length) throw new Error("Batch embedding output has no data");
  const dim = dims[dims.length - 1] ?? data.length;
  const results: number[][] = [];
  for (let i = 0; i < dims[0]; i++) {
    const start = i * dim;
    results.push(Array.from(data.slice(start, start + dim)));
  }
  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
