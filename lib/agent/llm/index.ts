/**
 * LLM Client — Hugging Face Transformers (local inference)
 */

import { pipeline, TextGenerationPipeline } from "@huggingface/transformers";

const MODEL_ID = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-360M-Instruct";

// Lazy-load the pipeline (downloads model on first use)
let generatorPromise: Promise<TextGenerationPipeline> | null = null;

function getGenerator(): Promise<TextGenerationPipeline> {
  if (!generatorPromise) {
    console.log(`Loading model: ${MODEL_ID} (this may take a while on first run)...`);
    generatorPromise = pipeline("text-generation", MODEL_ID) as Promise<TextGenerationPipeline>;
  }
  return generatorPromise;
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

  const output = await generator(messages, {
    max_new_tokens: 4096,
    do_sample: true,
    temperature: 0.7,
  });

  const result = output[0] as { generated_text: Array<{ role: string; content: string }> };
  const assistantMessage = result.generated_text.find(
    (msg) => msg.role === "assistant"
  );

  if (!assistantMessage) {
    throw new Error("No assistant response generated");
  }

  return assistantMessage.content;
}

