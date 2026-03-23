/**
 * Worker entry — runs in a Node worker_thread. Handles getStatus, load, chat and forwards progress.
 */

import { parentPort } from "node:worker_threads";
import {
  getModelStatus,
  loadModel,
  chatComplete,
  MODELS,
  type ModelProgress,
  type ModelOption,
  type ChatOptions,
} from "./pipeline";

type Incoming =
  | { id: string; type: "getStatus"; payload: { modelId?: string; dtype?: string } }
  | { id: string; type: "load"; payload: { modelId?: string; dtype?: ModelOption["dtype"] } }
  | { id: string; type: "chat"; payload: { systemPrompt: string; userMessage: string; options?: ChatOptions } };

type Outgoing =
  | { id: string; type: "resolve"; payload: unknown }
  | { id: string; type: "progress"; payload: ModelProgress & { models: ModelOption[] } }
  | { id: string; type: "reject"; payload: string };

function reply(msg: Outgoing) {
  parentPort?.postMessage(msg);
}

parentPort?.on("message", (msg: Incoming) => {
  const { id, type, payload } = msg;

  (async () => {
    try {
      switch (type) {
        case "getStatus": {
          const status = getModelStatus(payload.modelId, payload.dtype);
          reply({ id, type: "resolve", payload: { ...status, models: MODELS } });
          break;
        }
        case "load": {
          await loadModel(payload.modelId, payload.dtype, (progress) => {
            reply({
              id,
              type: "progress",
              payload: { ...progress, models: MODELS },
            });
          });
          const status = getModelStatus(payload.modelId, payload.dtype);
          reply({ id, type: "resolve", payload: { ...status, models: MODELS } });
          break;
        }
        case "chat": {
          const text = await chatComplete(payload.systemPrompt, payload.userMessage, payload.options);
          reply({ id, type: "resolve", payload: text });
          break;
        }
        default:
          reply({ id, type: "reject", payload: `Unknown message type: ${(msg as { type: string }).type}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply({ id, type: "reject", payload: message });
    }
  })();
});
