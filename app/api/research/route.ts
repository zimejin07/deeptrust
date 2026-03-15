import { runResearch } from "@/lib/agent";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    query,
    retrievedContext,
    contextUrls,
  }: {
    query: string;
    retrievedContext?: string;
    contextUrls?: string[];
  } = body;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (
        event: string,
        payload: { node: string; state: Record<string, unknown> }
      ) => {
        const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      // Initial "cursor-like" optimistic event
      send("start", {
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
        const options =
          retrievedContext != null || (contextUrls?.length ?? 0) > 0
            ? { knowledgeContext: retrievedContext ?? "", contextUrls: contextUrls ?? [] }
            : undefined;
        for await (const event of runResearch(
          query,
          "Research Session",
          options
        )) {
          send("research", event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send("error", {
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
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}