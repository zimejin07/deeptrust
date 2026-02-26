/**
 * LLM Client — Hugging Face Transformers (local inference)
 */

import { pipeline, TextGenerationPipeline } from "@huggingface/transformers";

const MODEL_ID = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-360M-Instruct";

// Lazy-load the pipeline (downloads model on first use)
let generatorPromise: Promise<TextGenerationPipeline> | null = null;

function getGenerator(): Promise<TextGenerationPipeline> {
  if (!generatorPromise) {
    console.log(`\n🔄 Loading model: ${MODEL_ID}`);
    console.log(`   This may take a few minutes on first run (downloading weights)...\n`);
    
    const startTime = Date.now();
    generatorPromise = (pipeline("text-generation", MODEL_ID) as Promise<TextGenerationPipeline>)
      .then((gen) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Model loaded in ${elapsed}s\n`);
        return gen;
      });
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

