# DeepTrust Research Agent

A TypeScript implementation of an autonomous research agent built with LangGraph state machines, local LLM inference via Hugging Face Transformers, and a Next.js frontend. This project demonstrates how to build a multi-node agent workflow with human-in-the-loop (HITL) checkpoints, policy-based auditing, and streaming state updates.

## Documentation

For a deeper dive into the system design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [State Management](#state-management)
5. [Graph Nodes](#graph-nodes)
6. [Routing and Conditional Edges](#routing-and-conditional-edges)
7. [LLM Integration](#llm-integration)
8. [API Layer](#api-layer)
9. [Frontend Client](#frontend-client)
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
│   └── index.ts       # Hugging Face Transformers client
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

app/
├── page.tsx           # Test client UI
└── api/
    ├── research/
    │   └── route.ts   # Research streaming endpoint
    └── model/
        └── load/
            └── route.ts # Model loading with progress
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

### Research Endpoint

`POST /api/research` streams state updates via newline-delimited JSON:

```typescript
export async function POST(req: NextRequest) {
  const { query } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for await (const event of runResearch(query)) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

### Model Loading Endpoint

`GET /api/model/load` streams download progress via Server-Sent Events:

```typescript
export async function GET() {
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      await loadModel((progress) => send(progress));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

---

## Frontend Client

The React client (`app/page.tsx`) provides:

1. **Model loading UI** with progress bar
2. **Query input** with pre-built test queries
3. **Streaming event display** showing node transitions
4. **Final report rendering**

### Streaming Pattern

```typescript
const response = await fetch("/api/research", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
});

const reader = response.body.getReader();
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
      const event = JSON.parse(line);
      setEvents((prev) => [...prev, event]);
    }
  }
}
```

---

## Running the Project

### Prerequisites

- Node.js 20+
- npm or pnpm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open http://localhost:3000. Click "Load Model" to download and initialize the LLM, then run research queries.

### First Run

The first model load downloads weights to `.hf-cache/` (approximately 400MB for SmolLM2-360M). Subsequent loads are fast.

---

## Configuration

Create `.env.local` from `.env.example`:

```bash
# Model selection
HF_MODEL=HuggingFaceTB/SmolLM2-360M-Instruct

# Cache directory (persists across restarts)
HF_CACHE_DIR=./.hf-cache
```

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
