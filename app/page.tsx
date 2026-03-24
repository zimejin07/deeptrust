"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface ModelProgress {
  status: "idle" | "loading" | "downloading" | "ready" | "error";
  progress: number;
  file: string;
  message: string;
  modelId?: string;
  dtype?: string;
  models?: ModelOption[];
}

interface ModelOption {
  id: string;
  label: string;
  dtype?: "q4" | "fp16" | "fp32";
  sizeNote?: string;
}

interface ResearchEvent {
  node: string;
  state: {
    threadId?: string;
    interrupt?: unknown;
    status?: string;
    plan?: {
      objective: string;
      steps: Array<{ tool: string; input: string; rationale?: string }>;
    };
    auditResult?: {
      verdict: "approved" | "rejected" | "needs_revision";
      policyViolations?: string[];
      suggestions?: string[];
    };
    finalReport?: string;
    reasoning?: Array<{ node: string; summary: string }>;
    errorMessage?: string;
  };
}

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  isStreaming?: boolean;
}

type KnowledgeItemType = "file" | "url" | "note";

interface KnowledgeItem {
  id: string;
  type: KnowledgeItemType;
  label: string;
  meta?: string;
  status?: "pending" | "indexing" | "indexed" | "error";
}

const DEFAULT_MODELS: ModelOption[] = [
  {
    id: "HuggingFaceTB/SmolLM2-135M-Instruct",
    label: "SmolLM2 135M (Q4, tiny)",
    dtype: "q4",
    sizeNote: "~150–200 MB (approx)",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    label: "SmolLM2 360M (Q4)",
    dtype: "q4",
    sizeNote: "~388 MB",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    label: "SmolLM2 360M (FP16)",
    dtype: "fp16",
    sizeNote: "~725 MB",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    label: "SmolLM2 360M (full)",
    dtype: "fp32",
    sizeNote: "~1.45 GB",
  },
];

const QUICK_ACTIONS = [
  "Deep dive with sources",
  "Use my uploaded docs",
  "Compare both sides",
  "Give me a summary",
  "Fact-check this claim",
];

const PREVIEW_QUERIES = [
  "Why is the cost of living rising faster than wages?",
  "What are the real pros and cons of remote work in 2026?",
  "How do noise-cancelling headphones actually work?",
];

export default function DeepTrustWorkspace() {
  const [modelStatus, setModelStatus] = useState<ModelProgress>({
    status: "idle",
    progress: 0,
    file: "",
    message: "Model not loaded",
  });
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const models = modelStatus.models?.length ? modelStatus.models : DEFAULT_MODELS;
  const selectedModel = models[selectedModelIndex] ?? null;

  const [query, setQuery] = useState(PREVIEW_QUERIES[0]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [hitlThreadId, setHitlThreadId] = useState<string | null>(null);
  const [hitlPayload, setHitlPayload] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");

  const streamAbortRef = useRef<AbortController | null>(null);
  const streamingTargetRef = useRef<string | null>(null);
  const streamingTimerRef = useRef<number | null>(null);
  const pendingFullTextRef = useRef<string | null>(null);

  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/model/load", { method: "POST" })
      .then((res) => res.json())
      .then((data: ModelProgress) => {
        setModelStatus((prev) => ({ ...prev, ...data }));
        if (data.models?.length && selectedModelIndex >= data.models.length) {
          setSelectedModelIndex(0);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hydrateKnowledge = useCallback(() => {
    import("@/lib/knowledge")
      .then(({ listKnowledgeItems }) => listKnowledgeItems())
      .then((items) => setKnowledgeItems(items))
      .catch(() => {});
  }, []);
  useEffect(() => {
    hydrateKnowledge();
  }, [hydrateKnowledge]);

  const startStreamingAnimation = useCallback((fullText: string, messageId: string) => {
    if (!fullText) return;
    if (streamingTimerRef.current) {
      window.clearInterval(streamingTimerRef.current);
    }

    const words = fullText.split(/\s+/);
    let index = 0;

    streamingTargetRef.current = messageId;

    setChat((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: "",
              isStreaming: true,
            }
          : m
      )
    );

    const timer = window.setInterval(() => {
      index += 1;
      const nextContent = words.slice(0, index).join(" ");

      setChat((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: nextContent,
              }
            : m
        )
      );

      if (index >= words.length) {
        if (streamingTimerRef.current) {
          window.clearInterval(streamingTimerRef.current);
        }
        streamingTimerRef.current = null;
        pendingFullTextRef.current = null;
        streamingTargetRef.current = null;
        setChat((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  isStreaming: false,
                }
              : m
          )
        );
        setIsStreaming(false);
      }
    }, 40);

    streamingTimerRef.current = timer;
  }, []);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chat]);

  const isModelReady =
    modelStatus.status === "ready" &&
    selectedModel &&
    modelStatus.modelId === selectedModel.id &&
    modelStatus.dtype === selectedModel.dtype;

  const isModelLoading =
    modelStatus.status === "loading" || modelStatus.status === "downloading";

  const loadModel = useCallback(async () => {
    if (!selectedModel) return;
    setModelStatus((prev) => ({ ...prev, status: "loading", message: "Starting..." }));

    try {
      const params = new URLSearchParams({ modelId: selectedModel.id });
      if (selectedModel.dtype) params.set("dtype", selectedModel.dtype);
      const response = await fetch(`/api/model/load?${params.toString()}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          if (chunk.startsWith("data: ")) {
            try {
              const data = JSON.parse(chunk.slice(6)) as ModelProgress;
              setModelStatus((prev) => ({ ...prev, ...data }));
            } catch {
              // ignore malformed progress chunks
            }
          }
        }
      }
    } catch (err) {
      setModelStatus((prev) => ({
        ...prev,
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load model",
      }));
    }
  }, [selectedModel]);

  const registerKnowledgeFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const pdfs = Array.from(files).filter((f) => f.type === "application/pdf");
    import("@/lib/knowledge").then(({ addPdfFile }) => {
      for (const file of pdfs) {
        const tempId = `temp-${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setKnowledgeItems((prev) => [
          ...prev,
          { id: tempId, type: "file" as KnowledgeItemType, label: file.name, meta: "Indexing…", status: "indexing" as const },
        ]);
        addPdfFile(file)
          .then((meta: KnowledgeItem) => {
            setKnowledgeItems((prev) => prev.map((x) => (x.id === tempId ? { ...meta, status: "indexed" as const } : x)));
          })
          .catch(() => {
            setKnowledgeItems((prev) => prev.map((x) => (x.id === tempId ? { ...x, status: "error" as const, meta: "Failed" } : x)));
          });
      }
    });
  }, []);

  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    if (event.dataTransfer.files?.length) registerKnowledgeFiles(event.dataTransfer.files);

    const urlPayload =
      event.dataTransfer.getData("text/uri-list") ||
      event.dataTransfer.getData("text/plain");

    if (urlPayload && /^https?:\/\//i.test(urlPayload.trim())) {
      const url = urlPayload.trim();
      import("@/lib/knowledge")
        .then(({ addUrl }) => addUrl(url))
        .then((meta) => setKnowledgeItems((prev) => [...prev, meta]))
        .catch(() => {});
    }
  };

  const handleDragOver: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  };

  const handleAddNote = () => {
    const value = noteDraft.trim();
    if (!value) return;
    import("@/lib/knowledge")
      .then(({ addNote }) => addNote(value))
      .then((meta) => {
        setKnowledgeItems((prev) => [...prev, meta]);
        setNoteDraft("");
      })
      .catch(() => {});
  };

  const handleAddUrl = () => {
    const value = urlDraft.trim();
    if (!value) return;
    import("@/lib/knowledge")
      .then(({ addUrl }) => addUrl(value))
      .then((meta) => {
        setKnowledgeItems((prev) => [...prev, meta]);
        setUrlDraft("");
      })
      .catch(() => {});
  };

  const handleRemoveKnowledgeItem = (id: string) => {
    import("@/lib/knowledge")
      .then(({ removeKnowledgeDocument }) => removeKnowledgeDocument(id))
      .then(() => setKnowledgeItems((prev) => prev.filter((x) => x.id !== id)))
      .catch(() => {});
  };

  const resetStreaming = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    if (streamingTimerRef.current) {
      window.clearInterval(streamingTimerRef.current);
      streamingTimerRef.current = null;
    }
    pendingFullTextRef.current = null;
    streamingTargetRef.current = null;
    setIsStreaming(false);
  }, []);

  const runResearch = useCallback(
    async (promptOverride?: string) => {
      const nextQuery = (promptOverride ?? query).trim();
      if (!nextQuery || !isModelReady || isStreaming) return;

      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
      }

      const controller = new AbortController();
      streamAbortRef.current = controller;

      setError(null);
      setEvents([]);
      setIsStreaming(true);

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: nextQuery,
      };
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        isStreaming: true,
      };

      setChat((prev) => [...prev, userMessage, assistantMessage]);

      try {
        let retrievedContext = "";
        let contextUrls: string[] = [];
        if (knowledgeItems.length > 0) {
          const { retrieve } = await import("@/lib/knowledge");
          const result = await retrieve(nextQuery);
          retrievedContext = result.retrievedContext;
          contextUrls = result.contextUrls;
        }
        const response = await fetch("/api/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: nextQuery,
            retrievedContext,
            contextUrls,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let hadError = false;
        const assistantId = assistantMessage.id;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const eventsRaw = buffer.split("\n\n");
          buffer = eventsRaw.pop() || "";

          for (const raw of eventsRaw) {
            const lines = raw.split("\n");
            let eventType = "message";
            let dataLine = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7);
              }
              if (line.startsWith("data: ")) {
                dataLine = line.slice(6);
              }
            }

            if (!dataLine) continue;

            try {
              const parsed = JSON.parse(dataLine) as ResearchEvent;
              if (eventType === "hitl_waiting" && parsed.node === "__interrupt__") {
                setHitlThreadId(parsed.state.threadId ?? null);
                setHitlPayload(parsed.state.interrupt ?? null);
                setIsStreaming(false);
                continue;
              }

              setEvents((prev) => [...prev, parsed]);

              if (parsed.node === "_error" || parsed.state.status === "failed") {
                const message =
                  parsed.state.errorMessage ?? "Research failed. See server logs for details.";
                setError(message);
                hadError = true;
                resetStreaming();
              }

              if (parsed.state.finalReport && !hadError) {
                pendingFullTextRef.current = parsed.state.finalReport;
              }

              if (pendingFullTextRef.current && !streamingTimerRef.current) {
                startStreamingAnimation(pendingFullTextRef.current, assistantId);
              }
            } catch (e) {
              console.warn("Failed to parse SSE event:", e);
            }
          }
        }

        if (!hadError && !streamingTimerRef.current) {
          setIsStreaming(false);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }

        setError(err instanceof Error ? err.message : "Unknown error");
        resetStreaming();
      }
    },
    [
      knowledgeItems,
      isModelReady,
      isStreaming,
      query,
      startStreamingAnimation,
      resetStreaming,
    ]
  );

  const handleQuickAction = (template: string) => {
    const composed = query ? `${query}\n\n${template}` : template;
    setQuery(composed);
    void runResearch(composed);
  };

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    void runResearch();
  };

  const isInputDisabled = !isModelReady || isStreaming;

  const handleApprovePlan = useCallback(async () => {
    if (!hitlThreadId) return;

    setIsStreaming(true);
    setError(null);

    const assistantMessage: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
    };
    setChat((prev) => [...prev, assistantMessage]);

    try {
      const response = await fetch("/api/research/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: hitlThreadId }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let hadError = false;
      const assistantId = assistantMessage.id;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const eventsRaw = buffer.split("\n\n");
        buffer = eventsRaw.pop() || "";

        for (const raw of eventsRaw) {
          const lines = raw.split("\n");
          let eventType = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7);
            }
            if (line.startsWith("data: ")) {
              dataLine = line.slice(6);
            }
          }

          if (!dataLine) continue;

          try {
            const parsed = JSON.parse(dataLine) as ResearchEvent;
            if (eventType === "error" || parsed.node === "_error" || parsed.state.status === "failed") {
              const message =
                parsed.state.errorMessage ?? "Research failed after approval. See server logs for details.";
              setError(message);
              hadError = true;
              resetStreaming();
            }

            setEvents((prev) => [...prev, parsed]);

            if (parsed.state.finalReport && !hadError) {
              pendingFullTextRef.current = parsed.state.finalReport;
            }

            if (pendingFullTextRef.current && !streamingTimerRef.current) {
              startStreamingAnimation(pendingFullTextRef.current, assistantId);
            }
          } catch (e) {
            console.warn("Failed to parse SSE event (approve):", e);
          }
        }
      }

      if (!hadError) {
        setIsStreaming(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error during approval");
      resetStreaming();
    } finally {
      setHitlThreadId(null);
      setHitlPayload(null);
    }
  }, [
    hitlThreadId,
    resetStreaming,
    startStreamingAnimation,
  ]);

  const handleRejectPlan = useCallback(() => {
    setHitlThreadId(null);
    setHitlPayload(null);
    setIsStreaming(false);
    setChat((prev) => [
      ...prev,
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content:
          "The proposed plan was rejected. Please refine your question or constraints, then try again.",
      },
    ]);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <main className="flex-1 flex flex-col lg:flex-row gap-6 px-4 sm:px-8 py-6 max-w-6xl mx-auto w-full">
        <section className="flex-1 flex flex-col border border-zinc-900/80 bg-zinc-950/60 rounded-3xl shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <header className="px-6 pt-5 pb-4 border-b border-zinc-900/80 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-400">Hi there</p>
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                Where should we start?
              </h2>
            </div>
            <div
              className={`px-3 py-1 rounded-full text-xs font-medium border ${
                isModelReady
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : isModelLoading
                  ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                  : modelStatus.status === "error"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              }`}
            >
              {isModelReady && "Model ready"}
              {isModelLoading && "Loading model…"}
              {modelStatus.status === "error" && "Model error"}
              {modelStatus.status === "idle" && "Model not loaded"}
            </div>
          </header>

          <div className="flex-1 flex flex-col">
            <div
              ref={chatScrollRef}
              className="flex-1 px-6 py-4 space-y-4 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent"
            >
              {chat.length === 0 && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {PREVIEW_QUERIES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      disabled={!isModelReady}
                      onClick={() => void runResearch(example)}
                      className="group text-left rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300 hover:border-zinc-500/80 hover:bg-zinc-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="block font-medium text-zinc-100 mb-1">
                        Try this
                      </span>
                      <span className="block text-zinc-400 text-xs line-clamp-3">
                        {example}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {chat.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                      message.role === "user"
                        ? "bg-zinc-100 text-zinc-900"
                        : "bg-zinc-900 text-zinc-100 border border-zinc-800"
                    }`}
                  >
                    {message.content || (message.isStreaming && (
                      <div className="space-y-2">
                        <div className="h-3 rounded-full bg-zinc-700/60 animate-pulse" />
                        <div className="h-3 w-2/3 rounded-full bg-zinc-800/60 animate-pulse" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-4 pb-4 pt-2 border-t border-zinc-900/80">
              <form
                onSubmit={handleSubmit}
                className="flex flex-col gap-3 rounded-2xl bg-zinc-950/80 border border-zinc-800 px-3 pt-2.5 pb-3 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
              >
                <textarea
                  rows={2}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={isInputDisabled}
                  placeholder="Ask DeepTrust anything about your code, docs, or ideas…"
                  className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-zinc-500 text-zinc-100"
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_ACTIONS.map((action) => (
                      <button
                        key={action}
                        type="button"
                        disabled={isInputDisabled}
                        onClick={() => handleQuickAction(action)}
                        className="rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {action}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    {isStreaming && (
                      <button
                        type="button"
                        onClick={resetStreaming}
                        className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded-full border border-zinc-800"
                      >
                        Stop
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={isInputDisabled}
                      className="inline-flex items-center justify-center rounded-full bg-zinc-100 text-zinc-950 text-xs font-medium px-4 py-2 hover:bg-white transition-colors disabled:bg-zinc-700 disabled:text-zinc-300 disabled:cursor-not-allowed"
                    >
                      {isStreaming ? "Thinking…" : "Run"}
                    </button>
                  </div>
                </div>
              </form>
              {error && (
                <p className="mt-2 text-xs text-red-400 border border-red-900/70 bg-red-950/60 rounded-xl px-3 py-2">
                  {error}
                </p>
              )}
            </div>
          </div>
        </section>

        <aside className="w-full lg:w-[320px] flex flex-col gap-4">
          <div className="rounded-3xl border border-zinc-900 bg-zinc-950/70 p-4 space-y-3 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500">
                  Model
                </p>
                <p className="text-sm font-medium">
                  {modelStatus.modelId || "Select a model"}
                </p>
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                  isModelReady
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : isModelLoading
                    ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                    : modelStatus.status === "error"
                    ? "border-red-500/40 bg-red-500/10 text-red-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400"
                }`}
              >
                {isModelReady && "Ready"}
                {isModelLoading && "Loading…"}
                {modelStatus.status === "error" && "Error"}
                {modelStatus.status === "idle" && "Not loaded"}
              </span>
            </div>

            {models.length > 0 && (
              <div>
                <select
                  value={selectedModelIndex}
                  onChange={(event) => setSelectedModelIndex(Number(event.target.value))}
                  disabled={isModelLoading}
                  className="w-full mt-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {models.map((model, index) => (
                    <option
                      key={`${model.id}-${model.dtype ?? "default"}`}
                      value={index}
                    >
                      {model.label} {model.sizeNote ? `— ${model.sizeNote}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {isModelLoading && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>{modelStatus.message}</span>
                  <span>{modelStatus.progress}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-900 overflow-hidden">
                  <div
                    className="h-full bg-sky-500 transition-all duration-300"
                    style={{ width: `${modelStatus.progress}%` }}
                  />
                </div>
              </div>
            )}

            {!isModelReady && !isModelLoading && (
              <button
                type="button"
                onClick={loadModel}
                className="w-full inline-flex items-center justify-center text-xs font-medium rounded-xl bg-zinc-100 text-zinc-950 py-2.5 hover:bg-white transition-colors"
              >
                Load model
              </button>
            )}

            {modelStatus.status === "error" && (
              <button
                type="button"
                onClick={loadModel}
                className="w-full text-[11px] text-red-300 underline underline-offset-2 hover:no-underline text-left"
              >
                Retry loading
              </button>
            )}
          </div>

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`rounded-3xl border-2 border-dashed px-4 py-4 space-y-3 transition-colors cursor-pointer ${
              isDragOver
                ? "border-zinc-200 bg-zinc-900/80"
                : "border-zinc-700/80 bg-zinc-950/60"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500">
                  Context
                </p>
                <p className="text-sm font-medium">
                  Drop PDFs, notes, or URLs
                </p>
              </div>
            </div>
            <p className="text-xs text-zinc-500">
              Drag files or links here. DeepTrust will use them as additional
              knowledge when answering.
            </p>

            <div className="flex gap-2">
              <label className="inline-flex cursor-pointer rounded-xl border border-zinc-700 bg-zinc-900/70 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 transition-colors">
                Attach files
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  className="hidden"
                  onChange={(event) => registerKnowledgeFiles(event.target.files)}
                />
              </label>
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder="Paste URL"
                  className="flex-1 rounded-xl bg-zinc-900/70 border border-zinc-800 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                />
                <button
                  type="button"
                  onClick={handleAddUrl}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/80 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                >
                  Add
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="Short note or hint"
                  className="flex-1 rounded-xl bg-zinc-900/70 border border-zinc-800 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                />
                <button
                  type="button"
                  onClick={handleAddNote}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/80 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                >
                  Save
                </button>
              </div>
            </div>

            {knowledgeItems.length > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-1 pt-1">
                {knowledgeItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-xl bg-zinc-900/70 border border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-200"
                  >
                    <span className="truncate min-w-0">
                      {item.type === "file" && "📄 "}
                      {item.type === "url" && "🔗 "}
                      {item.type === "note" && "✏️ "}
                      {item.label}
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {item.meta && (
                        <span className="text-[10px] text-zinc-500">
                          {item.meta}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveKnowledgeItem(item.id)}
                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {events.length > 0 && (
            <div className="space-y-3">
              {/* HITL approval banner */}
              {hitlThreadId && (
                <div className="rounded-3xl border border-amber-500/40 bg-amber-500/5 p-3 space-y-1.5">
                  <p className="text-xs font-medium text-amber-200">
                    Human review required
                  </p>
                  <p className="text-[11px] text-amber-100/90">
                    The agent has prepared a plan and is waiting for your approval before executing tools.
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleApprovePlan}
                      className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-emerald-500 text-emerald-950 hover:bg-emerald-400 transition-colors"
                    >
                      Approve & run tools
                    </button>
                    <button
                      type="button"
                      onClick={handleRejectPlan}
                      className="px-3 py-1.5 rounded-full text-[11px] font-medium border border-amber-400/60 text-amber-100 hover:bg-amber-500/10 transition-colors"
                    >
                      Reject plan
                    </button>
                  </div>
                </div>
              )}

              {/* Plan & audit snapshot */}
              {(() => {
                const latestWithPlan = [...events]
                  .reverse()
                  .find((e) => e.state.plan);
                const latestWithAudit = [...events]
                  .reverse()
                  .find((e) => e.state.auditResult);
                if (!latestWithPlan && !latestWithAudit) return null;

                const plan = latestWithPlan?.state.plan;
                const audit = latestWithAudit?.state.auditResult;

                return (
                  <div className="rounded-3xl border border-zinc-900 bg-zinc-950/70 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-zinc-400">
                        Plan & audit
                      </p>
                      {audit && (
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            audit.verdict === "approved"
                              ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                              : audit.verdict === "rejected"
                              ? "bg-red-500/10 text-red-300 border border-red-500/30"
                              : "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                          }`}
                        >
                          Audit: {audit.verdict}
                        </span>
                      )}
                    </div>
                    {plan && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] text-zinc-300">
                          {plan.objective}
                        </p>
                        <ol className="space-y-1 max-h-24 overflow-y-auto">
                          {plan.steps.map((step, idx) => (
                            <li
                              key={`${step.tool}-${idx}`}
                              className="text-[11px] text-zinc-400 flex gap-1.5"
                            >
                              <span className="mt-0.5 text-zinc-500">
                                {idx + 1}.
                              </span>
                              <span className="flex-1">
                                <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500 mr-1">
                                  {step.tool}
                                </span>
                                {step.input}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {audit?.policyViolations &&
                      audit.policyViolations.length > 0 && (
                        <div className="pt-1 border-t border-zinc-800/80 mt-1">
                          <p className="text-[10px] font-medium text-red-300 mb-0.5">
                            Policy flags
                          </p>
                          <ul className="space-y-0.5">
                            {audit.policyViolations.map((v, i) => (
                              <li
                                key={`${v}-${i}`}
                                className="text-[10px] text-red-200/90"
                              >
                                • {v}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                  </div>
                );
              })()}

              {/* Reasoning trace */}
              <div className="rounded-3xl border border-zinc-900 bg-zinc-950/70 p-3 space-y-1.5">
                <p className="text-xs font-medium text-zinc-400 mb-1">
                  Reasoning trace
                </p>
                <div className="max-h-40 overflow-y-auto space-y-1.5">
                  {events
                    .filter((event) => event.state.reasoning?.length)
                    .map((event, index) => {
                      const latest =
                        event.state.reasoning?.[
                          event.state.reasoning.length - 1
                        ];
                      if (!latest) return null;
                      return (
                        <div
                          key={`${event.node}-${index}`}
                          className="rounded-2xl bg-zinc-900/80 border border-zinc-800 px-3 py-1.5"
                        >
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-[10px] font-mono text-zinc-500">
                              {event.node}
                            </span>
                            {event.state.status && (
                              <span className="text-[10px] text-zinc-500">
                                {event.state.status}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-300 line-clamp-3">
                            {latest.summary}
                          </p>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
