import { loadModel, getModelStatus, MODELS } from "@/lib/agent/llm";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const modelId = searchParams.get("modelId") ?? undefined;
  const dtype = searchParams.get("dtype") ?? undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const status = getModelStatus(modelId, dtype);
      const requestedId = modelId ?? status.modelId;
      const requestedDtype = dtype ?? status.dtype;
      if (
        status.status === "ready" &&
        status.modelId === requestedId &&
        status.dtype === requestedDtype
      ) {
        send({ ...status, models: MODELS });
        controller.close();
        return;
      }

      send({
        status: "loading",
        progress: 0,
        message: "Starting model load...",
        modelId: modelId ?? status.modelId,
        dtype: dtype ?? status.dtype,
        models: MODELS,
      });

      try {
        await loadModel(modelId, dtype as "q4" | "fp16" | "fp32" | undefined, (progress) => {
          send({ ...progress, models: MODELS });
        });
        controller.close();
      } catch (error) {
        send({
          status: "error",
          progress: 0,
          message: error instanceof Error ? error.message : "Unknown error",
          modelId: modelId ?? undefined,
          dtype: dtype ?? undefined,
          models: MODELS,
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
  return Response.json({ ...status, models: MODELS });
}
