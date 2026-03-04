import { runResearch } from "@/lib/agent";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const { query } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Send immediately so the UI shows activity. The first graph event
      // only arrives after the thinker node finishes (one full LLM call),
      // which can take 1–3+ minutes on a slow machine.
      controller.enqueue(
        encoder.encode(
          JSON.stringify({
            node: "_start",
            state: {
              status: "started",
              plan: { objective: "Starting…", steps: [] },
              reasoning: [
                {
                  node: "_start",
                  summary:
                    "Research started. First step (planning) may take 1–2 minutes on slower devices.",
                },
              ],
            },
          }) + "\n"
        )
      );

      for await (const event of runResearch(query)) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}