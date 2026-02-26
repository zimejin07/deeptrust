"use client";

import { useState, useCallback } from "react";

interface ResearchEvent {
  node: string;
  state: {
    status?: string;
    plan?: {
      objective: string;
      steps: Array<{ tool: string; input: string }>;
    };
    finalReport?: string;
    reasoning?: Array<{ node: string; summary: string }>;
  };
}

const TEST_QUERIES = [
  "What is machine learning?",
  "Explain quantum computing in simple terms",
  "What caused the 2008 financial crisis?",
];

export default function TestClient() {
  const [query, setQuery] = useState(TEST_QUERIES[0]);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "streaming" | "complete" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const runResearch = useCallback(async () => {
    setEvents([]);
    setError(null);
    setStatus("loading");

    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      setStatus("streaming");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as ResearchEvent;
              setEvents((prev) => [...prev, event]);
            } catch {
              console.warn("Failed to parse event:", line);
            }
          }
        }
      }

      setStatus("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }, [query]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">DeepTrust Research Agent</h1>
        <p className="text-zinc-400 mb-8">Test client for the research API</p>

        {/* Query Input */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Research Query</label>
          <div className="flex gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500"
              placeholder="Enter your research question..."
            />
            <button
              onClick={runResearch}
              disabled={status === "loading" || status === "streaming"}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-colors"
            >
              {status === "loading" ? "Loading Model..." : status === "streaming" ? "Running..." : "Run Research"}
            </button>
          </div>
        </div>

        {/* Quick Query Buttons */}
        <div className="mb-8 flex gap-2 flex-wrap">
          {TEST_QUERIES.map((q) => (
            <button
              key={q}
              onClick={() => setQuery(q)}
              className="text-sm bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-md transition-colors"
            >
              {q}
            </button>
          ))}
        </div>

        {/* Status Indicator */}
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                status === "idle"
                  ? "bg-zinc-600"
                  : status === "loading"
                  ? "bg-yellow-500 animate-pulse"
                  : status === "streaming"
                  ? "bg-blue-500 animate-pulse"
                  : status === "complete"
                  ? "bg-green-500"
                  : "bg-red-500"
              }`}
            />
            <span className="text-sm text-zinc-400">
              {status === "idle" && "Ready to run"}
              {status === "loading" && "Loading model (first run may take a few minutes)..."}
              {status === "streaming" && `Receiving events... (${events.length} received)`}
              {status === "complete" && `Complete! (${events.length} events)`}
              {status === "error" && "Error occurred"}
            </span>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 bg-red-900/30 border border-red-800 rounded-lg p-4">
            <p className="text-red-400 font-medium">Error</p>
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* Events Stream */}
        {events.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Events</h2>
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {events.map((event, i) => (
                <div
                  key={i}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg p-4"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono bg-zinc-800 px-2 py-1 rounded">
                      {event.node}
                    </span>
                    {event.state.status && (
                      <span className="text-xs text-zinc-500">
                        Status: {event.state.status}
                      </span>
                    )}
                  </div>

                  {/* Plan Summary */}
                  {event.state.plan && (
                    <div className="text-sm">
                      <p className="text-zinc-300 mb-1">
                        <strong>Objective:</strong> {event.state.plan.objective}
                      </p>
                      <p className="text-zinc-500">
                        {event.state.plan.steps.length} steps planned
                      </p>
                    </div>
                  )}

                  {/* Reasoning */}
                  {event.state.reasoning && event.state.reasoning.length > 0 && (
                    <div className="text-sm text-zinc-400 mt-2">
                      <p>
                        {event.state.reasoning[event.state.reasoning.length - 1]?.summary}
                      </p>
                    </div>
                  )}

                  {/* Final Report */}
                  {event.state.finalReport && (
                    <div className="mt-2">
                      <p className="text-sm font-medium text-green-400 mb-1">Final Report</p>
                      <div className="text-sm text-zinc-300 whitespace-pre-wrap bg-zinc-800 p-3 rounded max-h-64 overflow-y-auto">
                        {event.state.finalReport}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
