// Avoid loading @huggingface/transformers on Vercel (no native runtime / disk); use dynamic import only when needed.
const isVercel = process.env.VERCEL === "1";

function unsupportedStream(encoder: TextEncoder): ReadableStream<Uint8Array> {
  const msg = {
    status: "error",
    progress: 0,
    message:
      "Model loading is not supported on Vercel (serverless). Run the app locally or self-host for local inference.",
    models: [] as { id: string; label: string; dtype?: string; sizeNote?: string }[],
  };
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
      controller.close();
    },
  });
}

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  if (isVercel) {
    return new Response(unsupportedStream(encoder), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const { loadModel, getModelStatus, MODELS } = await import("@/lib/agent/llm");
  const { searchParams } = new URL(request.url);
  const modelId = searchParams.get("modelId") ?? undefined;
  const dtype = searchParams.get("dtype") ?? undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const status = await getModelStatus(modelId, dtype);
      const requestedId = modelId ?? status.modelId;
      const requestedDtype = dtype ?? status.dtype;
      if (
        status.status === "ready" &&
        status.modelId === requestedId &&
        status.dtype === requestedDtype
      ) {
        send({ ...status, models: status.models ?? MODELS });
        controller.close();
        return;
      }

      send({
        status: "loading",
        progress: 0,
        message: "Starting model load...",
        modelId: modelId ?? status.modelId,
        dtype: dtype ?? status.dtype,
        models: status.models ?? MODELS,
      });

      try {
        await loadModel(modelId, dtype as "q4" | "fp16" | "fp32" | undefined, (progress) => {
          send({ ...progress, models: (progress as { models?: typeof MODELS }).models ?? MODELS });
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
      Connection: "keep-alive",
    },
  });
}

export async function POST() {
  if (isVercel) {
    return Response.json({
      status: "error",
      progress: 0,
      file: "",
      message:
        "Model loading is not supported on Vercel (serverless). Run the app locally or self-host for local inference.",
      models: [],
    });
  }

  const { getModelStatus, MODELS } = await import("@/lib/agent/llm");
  const status = await getModelStatus();
  return Response.json({ ...status, models: status.models ?? MODELS });
}
