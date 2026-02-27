import { loadModel, getModelStatus, MODEL_ID } from "@/lib/agent/llm";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Check if already loaded
      const status = getModelStatus();
      if (status.status === "ready") {
        send({ ...status, modelId: MODEL_ID });
        controller.close();
        return;
      }

      // Send initial status
      send({ status: "loading", progress: 0, message: "Starting model load...", modelId: MODEL_ID });

      try {
        await loadModel((progress) => {
          send({ ...progress, modelId: MODEL_ID });
        });
        controller.close();
      } catch (error) {
        send({ 
          status: "error", 
          progress: 0, 
          message: error instanceof Error ? error.message : "Unknown error",
          modelId: MODEL_ID
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export async function POST() {
  const status = getModelStatus();
  return Response.json({ ...status, modelId: MODEL_ID });
}
