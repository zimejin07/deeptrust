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
- **Tool Executor**: Executes each plan step sequentially (web search, document fetch, etc.)
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

    // Append-only reasoning log
    reasoning: {
      value: (existing: ReasoningEntry[], incoming: ReasoningEntry[]) =>
        [...(existing ?? []), ...(incoming ?? [])],
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
  tool: z.enum(["web_search", "document_fetch", "code_interpreter", "summarize"]),
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

`POST /api/research` streams research state updates as **Server-Sent Events** so the client can show progress immediately and parse events by type. Using SSE (instead of raw NDJSON) gives a standard, well-supported streaming protocol and allows future event names (e.g. `ping`, `heartbeat`) without changing the wire format.

**Request body:** `{ "query": string, "knowledge"?: Array<{ id, type, label, meta? }> }`. The `knowledge` array is sent by the workspace when the user adds files, URLs, or notes in the Context panel; the backend currently uses only `query` and may later use `knowledge` for RAG or plan conditioning.

**Response:** `Content-Type: text/event-stream`. Each message is an SSE message:

- `event: start` — First event; signals that the run has started (enables optimistic UI).
- `event: research` — One per graph node update; `data` is `{ node, state }`.
- `event: error` — On exception; `data` includes `node: "_error"` and `state.errorMessage`.

```typescript
// Server: send helper
const send = (event: string, payload: { node: string; state: Record<string, unknown> }) => {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
};
send("start", { node: "_start", state: { status: "started", ... } });
for await (const event of runResearch(query)) {
  send("research", event);
}
// On catch: send("error", { node: "_error", state: { status: "failed", errorMessage } });
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
| **Context / Knowledge** | Drag-and-drop zone for PDFs, text files, or URLs; optional fields to add URLs and short notes. Stored in React state and sent as `knowledge` with each research request for future backend use. |
| **Quick-action chips** | A row of buttons below the input (e.g. “Help me learn this topic”, “Summarize these docs”) that set or extend the query and trigger a run—Gemini-style shortcuts. |
| **Starter cards** | Empty state with example prompts (e.g. “How does Gemini Pro work…”) that fill the input and can be run in one click. |
| **Model card** | Compact panel for model selection, load/progress, and status (Ready / Loading / Error). |
| **Reasoning trace** | Scrollable list of the latest reasoning entries from the event stream (node + summary) for observability. |

### Optimistic UI and Shimmer

- On “Run Research”, the UI immediately appends the user message and a placeholder assistant message with a shimmer skeleton, then consumes SSE and updates that message when the final report arrives.
- Shimmer and loading states use Tailwind (e.g. `animate-pulse`, neutral backgrounds) so the interface feels responsive even when the agent is still planning or executing.

### SSE Consumption (Research)

The client uses `EventSource`-style parsing on the `ReadableStream`: split by `\n\n`, then for each line look for `event:` and `data:` and dispatch by event type. Accumulated `research` events update both the reasoning trace and the chat when `finalReport` is present.

```typescript
// Conceptual: read stream, split by double newline, parse "event:" and "data:"
const chunks = buffer.split("\n\n");
for (const chunk of chunks) {
  const eventMatch = chunk.match(/event:\s*(\w+)/);
  const dataMatch = chunk.match(/data:\s*(\{[\s\S]*\})/);
  if (eventMatch && dataMatch) {
    const payload = JSON.parse(dataMatch[1]);
    if (eventMatch[1] === "research") setEvents((prev) => [...prev, payload]);
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

Create `.env.local` from `.env.example`:

```bash
# Model selection
HF_MODEL=HuggingFaceTB/SmolLM2-360M-Instruct
HF_CACHE_DIR=./.hf-cache
```

### Observability (LangSmith)

To make agent behavior observable and debug failures (e.g. thinker returning invalid JSON), use [LangSmith](https://smith.langchain.com/). Set in `.env.local`:

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your-langsmith-api-key
LANGCHAIN_PROJECT=deeptrust
```

With tracing enabled, every graph run is recorded. You can inspect prompts, raw LLM outputs, and state transitions in the LangSmith UI, which helps diagnose schema validation errors and long-running or looping runs.

### Available Models

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| `HuggingFaceTB/SmolLM2-360M-Instruct` | 400MB | Fast | Basic |
| `HuggingFaceTB/SmolLM2-1.7B-Instruct` | 1.7GB | Moderate | Better |

---

## Key Concepts Demonstrated

1. **State Machines for Agents**: Using LangGraph to model complex, cyclic agent workflows
2. **Type-Safe State**: Zod schemas with TypeScript inference for runtime validation
3. **Local LLM Inference**: Running models in-process without external API dependencies
4. **Streaming Responses**: Server-Sent Events and ReadableStream for real-time updates
5. **Human-in-the-Loop**: Checkpoint interrupts for manual approval gates
6. **Revision Loops**: Cyclic graph edges for iterative refinement with safety ceilings

---

## License

MIT
