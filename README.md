---
title: DeepTrust Research Agent
emoji: 🔬
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 3000
pinned: false
short_description: LangGraph research agent workspace.
tags:
  - langgraph
  - nextjs
  - transformers
  - research-agent
  - llm
  - typescript
---

# DeepTrust Research Agent

A TypeScript implementation of an autonomous research agent: LangGraph state machines, local LLM inference (Hugging Face Transformers in a worker thread), and a real-time, AI-centric Next.js workspace. The UI is designed for a Cursor/Gemini-like flow—immediate feedback, Server-Sent Events (SSE) streaming, optimistic updates, a knowledge/context drop zone, and quick-action chips—so the full application from graph nodes to the browser is understandable in one read.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Low-level design: state machine, channels, routing, LLM layer, API protocols, and frontend architecture (SSE, streaming UX, knowledge flow).

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [State Management](#state-management)
5. [Graph Nodes](#graph-nodes)
6. [Routing and Conditional Edges](#routing-and-conditional-edges)
7. [LLM Integration](#llm-integration)
8. [API Layer](#api-layer)
9. [Frontend: Real-Time Workspace](#frontend-real-time-workspace)
10. [Running the Project](#running-the-project)
11. [Configuration](#configuration)
12. [FAQ: Architecture & design choices](#faq-architecture--design-choices)
13. [Client-side knowledge store (browser RAG)](#client-side-knowledge-store-browser-rag)

---

## Architecture Overview

DeepTrust implements a cyclic state graph where a research query flows through multiple specialized nodes:

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   [START] ──► thinker ──► auditor ──► tool_executor      │
│                  ▲           │              │            │
│                  │    reject │              │            │
│                  └───────────┘              ▼            │
│                                       synthesizer        │
│                                            │             │
│                                         [END]            │
└──────────────────────────────────────────────────────────┘
```

### Node Responsibilities

- **Thinker**: Decomposes a research question into a structured, multi-step plan
- **Auditor**: Validates the plan against organizational policy; rejects non-compliant plans
- **HITL Gate**: Pauses execution for human approval before tool execution
- **Tool Executor**: Executes each plan step sequentially (currently `web_search`; see [FAQ](#faq-architecture--design-choices))
- **Synthesizer**: Aggregates tool outputs into a final research report

The graph supports revision loops: if the Auditor rejects a plan, control returns to the Thinker with structured feedback. A configurable ceiling (`maxPlanRevisions`) prevents infinite loops.

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 | Server-side rendering, streaming UI updates |
| **State Machine** | LangGraph.js | Graph construction, checkpointing, conditional routing |
| **LLM Inference** | @huggingface/transformers | Local model loading and text generation |
| **Schema Validation** | Zod 4 | Runtime type validation for state and API contracts |
| **Type System** | TypeScript 5 | Static type safety across the codebase |

### Key Dependencies

```json
{
  "@langchain/langgraph": "^1.1.5",
  "@huggingface/transformers": "^3.8.1",
  "zod": "^4.3.6",
  "next": "16.1.6",
  "react": "19.2.3"
}
```

---

## Project Structure

```
lib/agent/
├── index.ts           # Public API exports
├── graph.ts           # StateGraph construction and compilation
├── state.ts           # Zod schemas and TypeScript types
├── routing.ts         # Conditional edge functions
├── llm/
│   ├── index.ts       # Worker proxy: loadModel, chatComplete, getModelStatus
│   ├── pipeline.ts    # Pipeline config (used by worker)
│   └── worker-entry.ts # Worker entry: runs Transformers in a separate thread
├── nodes/
│   ├── index.ts       # Node exports
│   ├── thinker.ts     # Plan generation node
│   ├── auditor.ts     # Policy validation node
│   ├── hitl-gate.ts   # Human approval checkpoint
│   ├── tool-executor.ts # Tool dispatch node
│   └── synthesizer.ts # Report synthesis node
└── utils/
    ├── index.ts       # Utility exports
    ├── extract-json.ts # Robust JSON parsing
    └── policy.ts      # Policy file loader

dist/llm/              # Built by npm run build:worker
├── worker-entry.js    # Compiled worker
└── pipeline.js        # Pipeline bundle

app/
├── page.tsx           # Workspace UI: chat, context panel, model card, SSE client
├── layout.tsx
├── globals.css
└── api/
    ├── research/
    │   └── route.ts   # POST: SSE stream of research events
    └── model/
        └── load/
            └── route.ts # GET/POST: model load + SSE progress
```

---

## State Management

### The ResearchState Schema

All state flows through a single Zod-validated schema. This ensures runtime type safety and enables serialization for checkpointing.

```typescript
export const ResearchState = z.object({
  // Identity
  threadId: z.string().uuid(),
  sessionName: z.string().default("Unnamed Session"),

  // Input
  userQuery: z.string().min(1),

  // Planning
  plan: ResearchPlan.nullable().default(null),
  rejectionFeedback: z.string().nullable().default(null),
  planRevisionCount: z.number().int().nonnegative().default(0),
  maxPlanRevisions: z.number().int().positive().default(5),

  // Auditing
  auditResult: AuditResult.nullable().default(null),

  // Execution
  currentStepIndex: z.number().int().nonnegative().default(0),
  humanApproved: z.boolean().default(false),

  // Output
  finalReport: z.string().nullable().default(null),

  // Observability
  reasoning: z.array(ReasoningEntry).default([]),
  status: RunStatus.default("idle"),
  updatedAt: z.string().datetime(),
  errorMessage: z.string().nullable().default(null),
});
```

### Channel Configuration

LangGraph requires explicit channel definitions for state merging. Most fields use last-write-wins semantics, but the `reasoning` array uses append-only concatenation:

```typescript
const graph = new StateGraph<ResearchState>({
  channels: {
    threadId: { value: (_, n) => n },
    // ... other scalar fields use (_, n) => n

    // Append-only reasoning log (nodes pass one new entry; cap matches state.ts)
    reasoning: {
      value: (existing: ReasoningEntry[], incoming: ReasoningEntry[]) => {
        const merged = [...(existing ?? []), ...(incoming ?? [])];
        const cap = 20;
        return merged.length > cap ? merged.slice(merged.length - cap) : merged;
      },
      default: () => [],
    },
  },
});
```

### Sub-Schemas

**ResearchStep**: A single action in the research plan.

```typescript
export const ResearchStep = z.object({
  id: z.string().uuid(),
  tool: z.enum(["web_search"]),
  input: z.string().min(1),
  rationale: z.string(),
  output: z.string().optional(),
  executedAt: z.string().datetime().optional(),
});
```

**AuditResult**: Structured feedback from the Auditor.

```typescript
export const AuditResult = z.object({
  verdict: z.enum(["approved", "rejected", "needs_revision"]),
  policyViolations: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  auditedAt: z.string().datetime(),
});
```

---

## Graph Nodes

Each node is an async function that receives the current state and returns a partial state update.

### Thinker Node

Generates or revises a research plan. Prompts the LLM with structured output requirements:

```typescript
async function thinkerNode(state: ResearchState): Promise<Partial<ResearchState>> {
  const isRevision = state.planRevisionCount > 0 && state.rejectionFeedback;

  const system = `
You are the Thinker node of DeepTrust, an autonomous research agent.
Return ONLY a valid JSON object matching:
{
  "objective": string,
  "steps": Array<{ "id": UUID, "tool": string, "input": string, "rationale": string }>,
  "estimatedTokenBudget": number,
  "createdAt": ISO8601,
  "revision": number
}`;

  const userMessage = isRevision
    ? `Research question: "${state.userQuery}"\n\nPREVIOUS PLAN REJECTED:\n${state.rejectionFeedback}`
    : `Research question: "${state.userQuery}"`;

  const rawThought = await chatComplete(system, userMessage);
  const parsed = extractJSON(rawThought);
  const plan = ResearchPlan.parse({ ...parsed, revision: state.planRevisionCount });

  return {
    plan,
    status: "thinking",
    rejectionFeedback: null,
    reasoning: appendReasoning(state, { node: "thinker", summary: "..." }),
    updatedAt: new Date().toISOString(),
  };
}
```

### Auditor Node

Validates plans against `POLICY.md`. Returns structured violations and suggestions:

```typescript
async function auditorNode(state: ResearchState): Promise<Partial<ResearchState>> {
  const policy = loadPolicy();

  const system = `
You are the Auditor node. Evaluate research plans against policy.
Return ONLY: { "verdict": "approved"|"rejected"|"needs_revision", ... }`;

  const rawThought = await chatComplete(system, `POLICY:\n${policy}\n\nPLAN:\n${JSON.stringify(state.plan)}`);
  const auditResult = AuditResult.parse(extractJSON(rawThought));

  const isRejected = auditResult.verdict !== "approved";

  return {
    auditResult,
    rejectionFeedback: isRejected ? formatFeedback(auditResult) : null,
    planRevisionCount: isRejected ? state.planRevisionCount + 1 : state.planRevisionCount,
    status: isRejected ? "thinking" : "awaiting_approval",
  };
}
```

### HITL Gate Node

Uses LangGraph's `interrupt()` primitive to pause execution and write a checkpoint:

```typescript
async function hitlGateNode(state: ResearchState): Promise<Partial<ResearchState>> {
  interrupt({
    message: "Plan ready for review. Set humanApproved=true to continue.",
    plan: state.plan,
    auditResult: state.auditResult,
  });

  return { updatedAt: new Date().toISOString() };
}
```

### Tool Executor Node

Iterates through plan steps. Each invocation processes one step and increments `currentStepIndex`:

```typescript
async function toolExecutorNode(state: ResearchState): Promise<Partial<ResearchState>> {
  const step = state.plan.steps[state.currentStepIndex];
  const output = await dispatchTool(step.tool, step.input);

  const updatedSteps = state.plan.steps.map((s, i) =>
    i === state.currentStepIndex ? { ...s, output, executedAt: new Date().toISOString() } : s
  );

  return {
    plan: { ...state.plan, steps: updatedSteps },
    currentStepIndex: state.currentStepIndex + 1,
    status: "executing",
  };
}
```

### Synthesizer Node

Aggregates all step outputs into a final report:

```typescript
async function synthesizerNode(state: ResearchState): Promise<Partial<ResearchState>> {
  const stepsContext = state.plan.steps
    .map((s, i) => `Step ${i + 1} [${s.tool}]: ${s.output}`)
    .join("\n\n");

  const finalReport = await chatComplete(
    "Write a comprehensive research report.",
    `Objective: ${state.plan.objective}\n\nResults:\n${stepsContext}`
  );

  return { finalReport, status: "complete" };
}
```

---

## Routing and Conditional Edges

LangGraph uses routing functions to determine the next node based on current state.

### Post-Audit Routing

```typescript
function routeAfterAudit(state: ResearchState): "thinker" | "hitl_gate" | typeof END {
  if (state.planRevisionCount >= state.maxPlanRevisions) {
    return END; // Safety ceiling reached
  }
  if (state.auditResult?.verdict !== "approved") {
    return "thinker"; // Loop back for revision
  }
  return "hitl_gate"; // Proceed to human approval
}
```

### Post-HITL Routing

```typescript
function routeAfterHitl(state: ResearchState): "tool_executor" | typeof END {
  if (!state.humanApproved) {
    return END; // Fail-safe if approval missing
  }
  return "tool_executor";
}
```

### Post-Tool Routing

```typescript
function routeAfterToolStep(state: ResearchState): "tool_executor" | "synthesizer" {
  if (state.currentStepIndex < state.plan.steps.length) {
    return "tool_executor"; // More steps remain
  }
  return "synthesizer"; // All steps complete
}
```

---

## LLM Integration

### Hugging Face Transformers

The project uses `@huggingface/transformers` for local inference. Models are cached to `.hf-cache/` for persistence across restarts.

```typescript
import { pipeline, TextGenerationPipeline, env } from "@huggingface/transformers";

env.cacheDir = process.env.HF_CACHE_DIR || "./.hf-cache";

const MODEL_ID = process.env.HF_MODEL || "HuggingFaceTB/SmolLM2-360M-Instruct";

let generatorPromise: Promise<TextGenerationPipeline> | null = null;

export function loadModel(onProgress?: ProgressCallback): Promise<TextGenerationPipeline> {
  if (generatorPromise) return generatorPromise;

  generatorPromise = pipeline("text-generation", MODEL_ID, {
    progress_callback: (data) => {
      onProgress?.({
        status: data.status === "progress" ? "downloading" : "loading",
        progress: Math.round((data.progress || 0) * 100),
        file: data.file || "",
        message: `Downloading ${data.file?.split("/").pop()}`,
      });
    },
  });

  return generatorPromise;
}
```

### Chat Completion Interface

```typescript
export async function chatComplete(systemPrompt: string, userMessage: string): Promise<string> {
  const generator = await loadModel();

  const output = await generator(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { max_new_tokens: 4096, do_sample: true, temperature: 0.7 }
  );

  const result = output[0] as { generated_text: Array<{ role: string; content: string }> };
  return result.generated_text.find((m) => m.role === "assistant")?.content ?? "";
}
```

### JSON Extraction

Small models often produce malformed JSON. The `extractJSON` utility handles common issues:

```typescript
export function extractJSON(text: string): unknown {
  // Try direct parse
  try { return JSON.parse(text); } catch {}

  // Remove markdown fences
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  // Extract JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }

  throw new Error(`Could not extract JSON from: ${text.slice(0, 200)}`);
}
```

---

## API Layer

### Research Endpoint (SSE)

`POST /api/research` streams research state updates as **Server-Sent Events** so the client can show progress immediately and parse events by type. Using SSE (instead of raw NDJSON) gives a standard, well-supported streaming protocol and allows future event names without changing the wire format.

**Request body:** `{ "query": string, "retrievedContext"?: string, "contextUrls"?: string[] }`. `retrievedContext` and `contextUrls` come from the client-side knowledge store (files/URLs/notes) and are used to condition the plan and synthesis steps.

**Response:** `Content-Type: text/event-stream`. Each message is an SSE message:

- `event: start` — First event; signals that the run has started (enables optimistic UI).
- `event: research` — One per graph node update; `data` is `{ node, state }`.
- `event: hitl_waiting` — Emitted when the graph reaches the HITL gate and pauses. `data` is `{ node: "__interrupt__", state: { threadId, interrupt } }`, which the client uses to show the approval banner and remember which `threadId` to resume.
- `event: error` — On exception; `data` includes `node: "_error"` and `state.errorMessage`.

```typescript
// Server: send helper
const send = (event: string, payload: { node: string; state: Record<string, unknown> }) => {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
};
send("start", { node: "_start", state: { status: "started", ... } });
for await (const event of runResearch(query, "Research Session", options)) {
  if (event.node === "__interrupt__") {
    send("hitl_waiting", event);
    return;
  }
  send("research", event);
}
// On catch: send("error", { node: "_error", state: { status: "failed", errorMessage } });

### HITL Approval Endpoint

`POST /api/research/approve` resumes a paused run after human approval. The client sends `{ "threadId": string }` (obtained from the earlier `hitl_waiting` event), and the server:

- Streams with LangGraph `Command({ resume: true, update: { humanApproved: true } })` so `interrupt()` in `hitl_gate` receives a resume value and state updates in one step.
- Streams the remaining `{ node, state }` events as `event: research` SSE messages until completion or error.
```

### Model Loading Endpoint

`GET /api/model/load?...modelId=...&dtype=...` (or POST with same query) streams download/load progress via SSE. The client parses `data: {...}` lines to drive the progress bar and status pill. See [Frontend: Real-Time Workspace](#frontend-real-time-workspace) for how the UI consumes these streams.

---

## Frontend: Real-Time Workspace

The React client (`app/page.tsx`) is a single-page workspace that mirrors a Cursor/Gemini-style flow: immediate, non-blocking feedback, streaming AI responses, and a dedicated context/knowledge area.

### What the UI Provides

| Area | Purpose |
|------|--------|
| **Chat** | User messages and assistant replies. When a run finishes, the final report is streamed **word-by-word** into the last assistant message to mimic a live conversation. |
| **Context / Knowledge** | Drag-and-drop zone for PDFs, text files, or URLs; optional fields to add URLs and short notes. Indexed on the client and summarized into `retrievedContext` + `contextUrls` for each research request. |
| **Quick-action chips** | A row of buttons below the input (e.g. “Help me learn this topic”, “Summarize these docs”) that set or extend the query and trigger a run—Gemini-style shortcuts. |
| **Starter cards** | Empty state with example prompts (e.g. “How does Gemini Pro work…”) that fill the input and can be run in one click. |
| **Model card** | Compact panel for model selection, load/progress, and status (Ready / Loading / Error). |
| **Plan & audit panel** | Shows the latest plan objective, step list, and audit verdict (approved / rejected / needs_revision), plus any policy violations. |
| **Reasoning trace** | Scrollable list of the latest reasoning entries from the event stream (node + summary + status) for observability. |

### Optimistic UI and Shimmer

- On “Run Research”, the UI immediately appends the user message and a placeholder assistant message with a shimmer skeleton, then consumes SSE and updates that message when the final report arrives.
- Shimmer and loading states use Tailwind (e.g. `animate-pulse`, neutral backgrounds) so the interface feels responsive even when the agent is still planning or executing.

### SSE Consumption (Research)

The client uses `EventSource`-style parsing on the `ReadableStream`: split by `\n\n`, then for each line look for `event:` and `data:` and dispatch by event type. Accumulated `research` events update both the reasoning trace and the chat when `finalReport` is present. A special `hitl_waiting` event updates local HITL state and shows the approval banner instead of treating the pause as an error.

```typescript
// Conceptual: read stream, split by double newline, parse "event:" and "data:"
const chunks = buffer.split("\n\n");
for (const chunk of chunks) {
  const eventMatch = chunk.match(/event:\s*(\w+)/);
  const dataMatch = chunk.match(/data:\s*(\{[\s\S]*\})/);
  if (eventMatch && dataMatch) {
    const payload = JSON.parse(dataMatch[1]);
    if (eventMatch[1] === "research") setEvents((prev) => [...prev, payload]);
    if (eventMatch[1] === "hitl_waiting" && payload.node === "__interrupt__") {
      setHitlThreadId(payload.state.threadId);
      setHitlPayload(payload.state.interrupt);
    }
    // ... handle start, error; when payload.state.finalReport exists, run word-by-word animation
  }
}
```

### Word-by-Word Streaming

When an event contains `state.finalReport`, the full text is not dumped at once. A small timer (e.g. every 40ms) reveals the report word-by-word in the last assistant message and clears the “streaming” state when done. This keeps the same SSE event payload while making the reply feel live.

---

## Running the Project

### Prerequisites

- Node.js 20+
- npm or pnpm

### Installation

```bash
npm install
```

### Build the LLM worker (required for local inference)

Inference runs in a Node.js worker thread. Compile the worker once before using the app locally:

```bash
npm run build:worker
```

This writes `dist/llm/worker-entry.js` and `dist/llm/pipeline.js`. The production build runs this step automatically.

### Development

```bash
npm run dev
```

Open http://localhost:3000. Click "Load Model" to download and initialize the LLM, then run research queries.

If you see an error that the worker was not found, run `npm run build:worker` first.

### Production build

```bash
npm run build
```

This runs `build:worker` then builds the Next.js app with webpack. The app is served with:

```bash
npm run start
```

### First run

The first model load downloads weights to `.hf-cache/` (approximately 400MB for SmolLM2-360M Q4). Subsequent loads are fast.

### Deploy (Render)

The repo includes a **Dockerfile** and config for [Render](https://render.com). Render builds the image in the cloud (no local Docker required). See **[DEPLOY.md](DEPLOY.md)** for steps.

---

## Configuration

Create `.env.local` from `.env.example` (copy the file and adjust values).

### Web search (research agent)

The plan step `web_search` runs in the tool executor. By default it queries **DuckDuckGo** over HTTPS (no API key). Optionally set **Google Custom Search** for programmatic web results:

- `GOOGLE_CSE_API_KEY` — API key from Google Cloud (Custom Search API enabled)
- `GOOGLE_CSE_CX` — Programmable Search Engine ID (cx)

If both are set, Google is used; otherwise DuckDuckGo. See comments in `.env.example`.

### Observability (LangSmith)

To make agent behavior observable and debug failures (e.g. thinker returning invalid JSON), use [LangSmith](https://smith.langchain.com/). Set in `.env.local`:

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your-langsmith-api-key
LANGCHAIN_PROJECT=deeptrust
```

With tracing enabled, every graph run is recorded. You can inspect prompts, raw LLM outputs, and state transitions in the LangSmith UI, which helps diagnose schema validation errors and long-running or looping runs.

This project forwards LangGraph metadata with each run:

- `project`: from `LANGCHAIN_PROJECT` (defaults to `deeptrust`)
- `run_name`: `"DeepTrust research session"`
- `source`: `"deeptrust-ui"`

These fields make it easier to filter and group traces in LangSmith.

### Available Models

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| `HuggingFaceTB/SmolLM2-360M-Instruct` | 400MB | Fast | Basic |
| `HuggingFaceTB/SmolLM2-1.7B-Instruct` | 1.7GB | Moderate | Better |

---

## Key Concepts Demonstrated

1. **State Machines for Agents**: Using LangGraph to model complex, cyclic agent workflows
2. **Type-Safe State**: Zod schemas with TypeScript inference for runtime validation
3. **Local LLM Inference**: Running models in a **worker thread** (not on the HTTP event loop) without cloud LLM APIs
4. **Streaming Responses**: Server-Sent Events and ReadableStream for real-time updates
5. **Human-in-the-Loop**: Checkpoint interrupts for manual approval gates
6. **Revision Loops**: Cyclic graph edges for iterative refinement with safety ceilings

---

## FAQ: Architecture & design choices

These answers are aimed at engineers reviewing the system end-to-end: how responsibilities are split, where state lives, and why the stack looks the way it does.

### Why Next.js for this project?

Next.js gives a **single TypeScript codebase** with a clear split between UI and server logic without introducing a separate BFF service. The **App Router** route handlers (`app/api/...`) are natural places for long-lived **Server-Sent Events (SSE)** streams: the research and model-load endpoints return `ReadableStream` bodies and push typed events to the client. That matches how we want the workspace to feel—incremental updates, no second HTTP framework to deploy. Next also aligns with **Hugging Face Spaces** and container-style hosts (Dockerfile): one Node process serves the UI and APIs, which simplifies ops compared to a static SPA plus a standalone API server.

### How is the “agent” separated from the web app?

**`lib/agent/`** is the domain layer: LangGraph construction (`graph.ts`), Zod state (`state.ts`), routing functions, node implementations, LLM facades, and utilities. **`app/`** owns HTTP boundaries (`app/api/**/route.ts`), the SSE wire format, and the React workspace (`app/page.tsx`). The dependency rule is one-way: **application code imports the agent; the agent never imports React, Next.js, or route handlers.** That keeps orchestration **portable**—the same `runResearch` / `approveAndResume` entry points could be invoked from a script, a different framework, or a job runner without pulling UI code along.

Concretely:

- **`lib/agent/index.ts`** is the narrow public seam: graph helpers, Zod types, `chatComplete` / model helpers, and utilities. Everything else under `lib/agent/` is internal to the agent package.
- **Nodes** (`thinker`, `auditor`, `synthesizer`) only depend on `chatComplete`, state schemas, and helpers—they do not know whether the caller is an API route or a test harness.
- **Side-effecting work** (policy file read, `fetch` for web search) lives in nodes and tools, not in `app/`, so policy and tool behavior stay centralized.
- **Route handlers** stay thin: validate input, build options, iterate async generators from the graph, and encode events as SSE. No business rules in the route.

Net effect: the **graph and prompts are the product’s brain**; Next.js is a **host** for I/O and rendering, not a place where control flow leaks.

### Why keep embeddings and vector storage in the browser (`lib/knowledge`)?

See [Client-side knowledge store (browser RAG)](#client-side-knowledge-store-browser-rag) for the full picture—briefly: **privacy** (documents stay on-device), **no server vector DB** to run or pay for, and **CORS-free** PDF/text handling in the user’s browser. The tradeoff is retrieval runs client-side and only **derived text** (`retrievedContext` + `contextUrls`) is sent to the API.

### Why LangGraph instead of a hand-rolled loop?

Research here is inherently **cyclic** (thinker ↔ auditor revisions, tool steps, HITL). LangGraph provides an explicit **StateGraph**, **checkpointing** keyed by `thread_id`, and first-class **interrupt/resume** for human approval. Conditional edges encode policy (“approved → HITL”, “rejected → thinker”) in one place instead of scattering `if` chains across services. We still treat LLM outputs as untrusted: Zod validation, JSON extraction helpers, and retry/feedback loops live in nodes—LangGraph carries the **control flow**, not business shortcuts.

### How is core state handled?

There is **one canonical state shape** (`ResearchState` in `state.ts`), validated with **Zod** at creation and when parsing LLM-derived structures. LangGraph **channels** define merge semantics: scalars are last-write-wins; `reasoning` is append-only with a **bounded tail** so traces stay useful without unbounded memory growth. Serialized checkpoints must be JSON-safe, which drives field choices (ISO strings, plain objects). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for channel details and SSE payloads.

### Why run the LLM in a worker thread?

Local inference via `@huggingface/transformers` is **CPU/GPU-heavy** and would **block the Node event loop** on the main thread during load and generation—unacceptable for a server that must accept new HTTP connections and **stream SSE** for research and model progress.

**What we built:**

1. **Dedicated worker bundle** — `tsconfig.worker.json` compiles only `lib/agent/llm/pipeline.ts` and `worker-entry.ts` to **`dist/llm/`**. The heavy Transformers pipeline is not bundled into the Next server chunk; you run **`npm run build:worker`** (or full `npm run build`) before first use. The main thread loads **`dist/llm/worker-entry.js`** via `new Worker(workerPath)`.

2. **Singleton worker + async RPC** — `lib/agent/llm/index.ts` spawns **one** `Worker`, lazily on first request. The main thread sends `{ id, type, payload }` messages (`getStatus`, `load`, `chat`); the worker replies with `resolve` / `reject` or **interleaved `progress`** during model download/load. A **`pending` `Map`** correlates `id` to Promise resolvers so concurrent API calls (e.g. model status + a chat from different requests) do not trample each other.

3. **Stable surface for the agent** — Nodes call **`chatComplete(system, user)`** and **`loadModel`** without knowing about threads. Swapping the implementation later (remote API, different runtime) means changing **`llm/index.ts`** and the worker contract, not every node.

4. **Operational visibility** — the worker is created with `stdout`/`stderr` piped through, which helps when debugging downloads and crashes on **Hugging Face Spaces** or Docker.

So the split is not cosmetic: it is **event-loop isolation** plus a **minimal RPC boundary** between “web server” and “inference engine,” which is the same architectural move you would make for image processing or any other long-running native work beside Express/Next.

### Why SSE for the workspace instead of WebSockets?

The client mostly needs **server → browser** push (research events, model progress, errors). **SSE** over a normal HTTP POST/GET response is simpler than WebSockets for that shape: standard proxies understand it, reconnect semantics are straightforward, and route handlers stay a single request lifecycle. Bidirectional chat beyond “approve this plan” is not required for the core loop; the approve path is a second POST with its own stream.

### How are human-in-the-loop and resume implemented?

After an approved audit, **`hitl_gate`** calls LangGraph’s **`interrupt()`**, which checkpoints and pauses until the graph is resumed with a **`Command`** carrying a `resume` value and state updates (e.g. `humanApproved: true`). The UI stores `threadId` from the `hitl_waiting` event; **`POST /api/research/approve`** streams again from that checkpoint. Using `Command` is important: a bare `stream(null)` without a resume value does not satisfy `interrupt()` and the run would stall.

### How do policy, auditor, and tools relate?

**Policy** (`POLICY.md` / default text) is the rule set; the **Auditor** node prompts the LLM to emit structured verdicts. Small models often parrot placeholders or noise, so the codebase includes **normalization and guardrails** (e.g. treating obvious nonsense violations as non-blocking) to keep the product usable—this is a pragmatic layer on top of “ideal” policy enforcement. **Tools** execute only after HITL approval; **`web_search`** runs on the server with optional Google CSE env vars and a DuckDuckGo default, keeping secrets out of the client.

### What is intentionally out of scope or “phase 2”?

Persistent checkpoints beyond **in-memory** `MemorySaver` (e.g. Postgres), additional tools (`document_fetch`, code execution), and parallel step execution are documented as extensions in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The current architecture is optimized for **clarity, local inference, and a single deployable** rather than maximum throughput.

---

## Client-side knowledge store (browser RAG)

**`lib/knowledge/`** implements a **small vector retrieval layer entirely in the browser**. It is not used by the server-side agent directly; instead the React client **indexes** user documents locally, **retrieves** relevant snippets for the current query, and passes **`retrievedContext`** and **`contextUrls`** in the JSON body of `POST /api/research`. The Thinker and Synthesizer inject that text into prompts on the server (`ResearchState.knowledgeContext` / `contextUrls`). This keeps raw files out of the request body and avoids shipping user PDFs to your backend.

### Components

| Piece | Role |
|-------|------|
| **IndexedDB** (`db.ts`) | Database `deeptrust-knowledge` with object stores **`documents`** (metadata: id, type, label, optional url) and **`chunks`** (text segments + embedding vectors). Chunks are indexed **`byDocument`** so deleting a document removes its chunks in one transaction. |
| **Embeddings** (`embeddings.ts`) | **`@xenova/transformers`** runs **`feature-extraction`** with **`Xenova/all-MiniLM-L6-v2`** in the browser (lazy singleton pipeline). Vectors are **L2-normalized**; **cosine similarity** is computed in plain JavaScript for query ↔ chunk scoring. |
| **Chunking** (`chunk.ts`) | Fixed windows (~500 chars, ~80 overlap, word-boundary friendly) for PDF and note text so long documents become many retrievable units. |
| **PDFs** (`pdf.ts`) | Text extraction in the client before chunk/embed (no server-side PDF parser required for v1). |
| **Store** (`store.ts`) | Orchestrates **add** (PDF, note, URL), **list**, **remove**, and **`retrieve`**. Ingestion embeds each chunk and persists to IndexedDB. URLs are stored as **reference-only** rows (embedding of a short `URL: …` string); the app does **not** fetch arbitrary URLs server-side in v1. |

### Retrieval

On research submit, the client calls **`retrieve(query)`**: embed the query, score **every stored chunk** against it (cosine similarity), take **top-K** (currently 8), and concatenate chunk text into **`retrievedContext`** with source labels. URL-type documents contribute their hrefs to **`contextUrls`**. This is a **linear scan over chunks**—appropriate for local, modest corpora; a future upgrade could add an approximate index or server-side sync without changing the agent contract.

### Boundaries

- **Import only from client components** (or dynamic `import()` from the client bundle). IndexedDB and Xenova require **`window`**; `db.ts` rejects server-side `openDB()`.
- **Server LLM** (SmolLM in the worker) is separate from **embedding** (MiniLM in the tab): two different models for two roles.
- **Privacy**: IndexedDB is per-origin; clearing site data clears the store. Only the **retrieved** snippet string crosses the wire to your API, not the full original files.

---

## License

MIT
