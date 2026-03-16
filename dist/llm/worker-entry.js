"use strict";
/**
 * Worker entry — runs in a Node worker_thread. Handles getStatus, load, chat and forwards progress.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_worker_threads_1 = require("node:worker_threads");
const pipeline_1 = require("./pipeline");
function reply(msg) {
    node_worker_threads_1.parentPort?.postMessage(msg);
}
node_worker_threads_1.parentPort?.on("message", (msg) => {
    const { id, type, payload } = msg;
    (async () => {
        try {
            switch (type) {
                case "getStatus": {
                    const status = (0, pipeline_1.getModelStatus)(payload.modelId, payload.dtype);
                    reply({ id, type: "resolve", payload: { ...status, models: pipeline_1.MODELS } });
                    break;
                }
                case "load": {
                    await (0, pipeline_1.loadModel)(payload.modelId, payload.dtype, (progress) => {
                        reply({
                            id,
                            type: "progress",
                            payload: { ...progress, models: pipeline_1.MODELS },
                        });
                    });
                    const status = (0, pipeline_1.getModelStatus)(payload.modelId, payload.dtype);
                    reply({ id, type: "resolve", payload: { ...status, models: pipeline_1.MODELS } });
                    break;
                }
                case "chat": {
                    const text = await (0, pipeline_1.chatComplete)(payload.systemPrompt, payload.userMessage);
                    reply({ id, type: "resolve", payload: text });
                    break;
                }
                default:
                    reply({ id, type: "reject", payload: `Unknown message type: ${msg.type}` });
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            reply({ id, type: "reject", payload: message });
        }
    })();
});
