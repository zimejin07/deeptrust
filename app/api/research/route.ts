import { runResearch } from "@/lib/agent";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const { query } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: { node: string; state: Record<string, unknown> }) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      send({
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
      });

      try {
        for await (const event of runResearch(query)) {
          send(event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({
          node: "_error",
          state: {
            status: "failed",
            errorMessage: message,
          },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}