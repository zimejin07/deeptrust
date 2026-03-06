"use strict";
/**
 * Pipeline — runs inside the LLM worker thread only.
 * Hugging Face Transformers + onnxruntime-node; state lives in this thread.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODELS = exports.MODEL_ID = void 0;
exports.getModelStatus = getModelStatus;
exports.loadModel = loadModel;
exports.chatComplete = chatComplete;
const transformers_1 = require("@huggingface/transformers");
const node_path_1 = __importDefault(require("node:path"));
transformers_1.env.cacheDir =
    process.env.HF_CACHE_DIR ||
        node_path_1.default.join(process.cwd(), ".hf-cache");
exports.MODEL_ID = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-360M-Instruct";
exports.MODELS = [
    { id: "HuggingFaceTB/SmolLM2-360M-Instruct", label: "SmolLM2 360M (Q4)", dtype: "q4", sizeNote: "~388 MB" },
    { id: "HuggingFaceTB/SmolLM2-360M-Instruct", label: "SmolLM2 360M (FP16)", dtype: "fp16", sizeNote: "~725 MB" },
    { id: "HuggingFaceTB/SmolLM2-360M-Instruct", label: "SmolLM2 360M (full)", dtype: "fp32", sizeNote: "~1.45 GB" },
];
let currentModelId = exports.MODELS[0].id;
let currentDtype = exports.MODELS[0].dtype;
let generatorPromise = null;
let isModelLoaded = false;
let currentProgress = 0;
let currentStatus = "idle";
let currentFile = "";
function getModelStatus(forModelId, forDtype) {
    const isOther = forModelId !== undefined && (forModelId !== currentModelId || forDtype !== currentDtype);
    if (isOther) {
        return {
            status: "idle",
            progress: 0,
            file: "",
            message: "Model not loaded",
            modelId: forModelId,
            dtype: forDtype,
        };
    }
    if (isModelLoaded) {
        return {
            status: "ready",
            progress: 100,
            file: "",
            message: "Model ready",
            modelId: currentModelId,
            dtype: currentDtype,
        };
    }
    if (generatorPromise) {
        return {
            status: currentStatus,
            progress: currentProgress,
            file: currentFile,
            message: currentFile ? `Downloading ${currentFile}` : "Loading model...",
            modelId: currentModelId,
            dtype: currentDtype,
        };
    }
    return {
        status: "idle",
        progress: 0,
        file: "",
        message: "Model not loaded",
        modelId: currentModelId,
        dtype: currentDtype,
    };
}
function loadModel(modelId, dtype, onProgress) {
    const nextId = modelId ?? currentModelId;
    const nextDtype = dtype ?? currentDtype;
    if (nextId !== currentModelId || nextDtype !== currentDtype) {
        generatorPromise = null;
        isModelLoaded = false;
        currentModelId = nextId;
        currentDtype = nextDtype;
        currentStatus = "idle";
        currentProgress = 0;
        currentFile = "";
    }
    if (generatorPromise) {
        return generatorPromise;
    }
    console.log(`\n🔄 [worker] Loading model: ${currentModelId}${currentDtype ? ` (${currentDtype})` : ""}`);
    console.log(`   Cache directory: ${transformers_1.env.cacheDir}\n`);
    currentStatus = "loading";
    const startTime = Date.now();
    const pipelineOptions = {
        progress_callback: (progressData) => {
            currentStatus = progressData.status === "progress" ? "downloading" : "loading";
            currentFile = progressData.file || progressData.name || "";
            currentProgress = Math.round(progressData.progress ?? 0);
            const update = {
                status: currentStatus,
                progress: currentProgress,
                file: currentFile,
                message: currentFile
                    ? `Downloading ${currentFile.split("/").pop()} (${currentProgress}%)`
                    : `${progressData.status}...`,
                modelId: currentModelId,
                dtype: currentDtype,
            };
            console.log(`   ${update.message}`);
            onProgress?.(update);
        },
    };
    if (currentDtype) {
        pipelineOptions.dtype = currentDtype;
    }
    const pipelinePromise = (0, transformers_1.pipeline)("text-generation", currentModelId, pipelineOptions);
    generatorPromise = pipelinePromise
        .then((gen) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [worker] Model loaded in ${elapsed}s\n`);
        isModelLoaded = true;
        currentStatus = "ready";
        currentProgress = 100;
        onProgress?.({
            status: "ready",
            progress: 100,
            file: "",
            message: "Model ready",
            modelId: currentModelId,
            dtype: currentDtype,
        });
        return gen;
    })
        .catch((err) => {
        currentStatus = "error";
        generatorPromise = null;
        onProgress?.({
            status: "error",
            progress: 0,
            file: "",
            message: err.message,
            modelId: currentModelId,
            dtype: currentDtype,
        });
        throw err;
    });
    return generatorPromise;
}
async function chatComplete(systemPrompt, userMessage) {
    const generator = await loadModel();
    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
    ];
    const preview = userMessage.slice(0, 60).replace(/\n/g, " ");
    console.log(`🤖 [worker] Generating response for: "${preview}..."`);
    const startTime = Date.now();
    const output = await generator(messages, {
        max_new_tokens: 4096,
        do_sample: true,
        temperature: 0.7,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const result = output[0];
    const assistantMessage = result.generated_text.find((msg) => msg.role === "assistant");
    if (!assistantMessage) {
        throw new Error("No assistant response generated");
    }
    console.log(`✅ [worker] Generated ${assistantMessage.content.length} chars in ${elapsed}s`);
    return assistantMessage.content;
}
