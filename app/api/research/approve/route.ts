import { approveAndResume } from "@/lib/agent";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { threadId } = body as { threadId?: string };

  if (!threadId) {
    return new Response(
      JSON.stringify({ error: "threadId is required to approve a run" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

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

      try {
        for await (const event of approveAndResume(threadId)) {
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

