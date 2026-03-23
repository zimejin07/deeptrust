# DeepTrust Architecture

This document provides a detailed technical overview of the DeepTrust Research Agent architecture, covering the state machine design, data flow, and implementation patterns.

## System Overview

DeepTrust is a research automation system that orchestrates an LLM through a multi-stage workflow. The system decomposes research questions into executable plans, validates them against policy, executes tool calls, and synthesizes results into reports.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (app/page.tsx)                             │
│  ┌─────────────┐  ┌─────────────────────────────────────────────────────┐  │
│  │ Model Card  │  │  Chat + Context panel                                 │  │
│  │ (SSE load)  │  │  • Messages (user / assistant with word-by-word)    │  │
│  └──────┬──────┘  │  • Knowledge drop zone (files, URLs, notes)          │  │
│         │         │  • Quick-action chips, preview prompts               │  │
│         │         │  • Reasoning trace (node summaries)                   │  │
│         │         └──────────────────────────┬──────────────────────────┘  │
└─────────┼───────────────────────────────────┼─────────────────────────────┘
          │                                     │
          ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API LAYER                                      │
│  ┌─────────────────────┐  ┌─────────────────────────────────────┐          │
│  │ GET/POST             │  │ POST /api/research                   │          │
│  │ /api/model/load      │  │ (SSE: event + data per research step │          │
│  │ (SSE progress)       │  └─────────────────┬───────────────────┘          │
│  └─────────┬───────────┘                      │                             │
│            │                                   │                             │
│            │           ┌─────────────────────────────────────┐               │
│            │           │ POST /api/research/approve          │               │
│            │           │ (resume after HITL approval)        │               │
│            │           └─────────────────────────────────────┘               │
└────────────┼─────────────────────────────────┼─────────────────────────────┘
             │                                 │
             ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AGENT CORE (lib/agent)                         │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐  │
│  │   LLM Client     │  │              StateGraph                         │  │
│  │ (worker thread)  │  │  ┌─────────┐  ┌─────────┐  ┌──────────────┐    │  │
│  │  loadModel()     │  │  │ Thinker │──│ Auditor │──│ Tool Executor │    │  │
│  │  chatComplete()  │◄─┼──└────▲────┘  └────┬────┘  └──────┬───────┘    │  │
│  └─────────────────┘  │       │            │               │            │  │
│                        │       └────────────┘               ▼            │  │
│                        │                        ┌───────────────┐       │  │
│                        │                        │  Synthesizer  │       │  │
│                        │                        └───────────────┘       │  │
│                        └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## State Machine Design

### LangGraph StateGraph

The agent is implemented as a LangGraph `StateGraph<ResearchState>`. LangGraph provides:

1. **Typed State Channels**: Each state field has a merge strategy
2. **Conditional Routing**: Functions determine the next node based on state
3. **Checkpointing**: State snapshots enable pause/resume workflows
4. **Streaming**: Events are yielded as nodes complete

### State Flow

```
Initial State
     │
     ▼
┌─────────┐
│ thinker │ ◄──────────────────────────────┐
└────┬────┘                                │
     │ produces plan                       │
     ▼                                     │
┌─────────┐                                │
│ auditor │                                │
└────┬────┘                                │
     │                                     │
     ├── verdict: "rejected" ──────────────┘
     │   (planRevisionCount++)              
     │                                      
     ├── planRevisionCount >= max ──────► END
     │                                      
     └── verdict: "approved"
         │
         ▼
   ┌───────────┐
   │ hitl_gate │ ◄─── interrupt() pauses here
   └─────┬─────┘
         │ humanApproved = true (external)
         ▼
  ┌───────────────┐
  │ tool_executor │ ◄─────────────┐
  └───────┬───────┘               │
          │                       │
          ├── more steps ─────────┘
          │                        
          └── all steps done
              │
              ▼
       ┌─────────────┐
       │ synthesizer │
       └──────┬──────┘
              │
              ▼
             END
```

### Channel Merge Strategies

LangGraph channels define how incoming state updates merge with existing state:

| Field | Strategy | Rationale |
|-------|----------|-----------|
| `reasoning` | Append + cap | Nodes pass **one** new entry per update; reducer concatenates and keeps the last 20 (`MAX_REASONING_ENTRIES` in `state.ts`) |
| All others | Replace | Last-write-wins for scalar values |

```typescript
channels: {
  reasoning: {
    value: (existing, incoming) => {
      const merged = [...(existing ?? []), ...(incoming ?? [])];
      const cap = 20; // MAX_REASONING_ENTRIES in state.ts
      return merged.length > cap ? merged.slice(merged.length - cap) : merged;
    },
    default: () => [],
  },
  plan: { value: (_, n) => n },
  // ...
}
```

`appendReasoning` returns a **single-element** array so the reducer performs one append per node; this avoids duplicating the full history on every write.

## Data Schemas

### Type System Philosophy

All data structures use Zod for runtime validation. TypeScript types are inferred from Zod schemas, ensuring a single source of truth.

```typescript
// Schema definition
export const ResearchStep = z.object({
  id: z.string().uuid(),
  tool: z.enum(["web_search"]),
  input: z.string().min(1),
  rationale: z.string(),
  output: z.string().optional(),
});

// Type inference (no manual duplication)
export type ResearchStep = z.infer<typeof ResearchStep>;
```

### Schema Hierarchy

```
ResearchState (root)
├── threadId: UUID
├── userQuery: string
├── plan: ResearchPlan | null
│   ├── objective: string
│   ├── steps: ResearchStep[]
│   │   ├── id: UUID
│   │   ├── tool: enum
│   │   ├── input: string
│   │   ├── rationale: string
│   │   └── output?: string
│   ├── estimatedTokenBudget: number
│   └── revision: number
├── auditResult: AuditResult | null
│   ├── verdict: enum
│   ├── policyViolations: string[]
│   └── suggestions: string[]
├── reasoning: ReasoningEntry[]
│   ├── node: enum
│   ├── timestamp: datetime
│   ├── summary: string
│   └── rawThought?: string
└── status: enum
```

## Node Implementation Patterns

### Node Function Signature

All nodes follow the same pattern:

```typescript
async function nodeName(state: ResearchState): Promise<Partial<ResearchState>> {
  // 1. Read required state
  // 2. Perform computation (LLM calls, tool execution, etc.)
  // 3. Return partial state update
}
```

LangGraph merges the returned partial state into the existing state using channel strategies.

### Prompt Engineering Pattern

Each LLM-calling node structures prompts for reliable JSON output:

```typescript
const system = `
You are the [Role] node of DeepTrust.
[Brief description of responsibility]

Return ONLY a valid JSON object matching:
{
  "field1": type,
  "field2": type
}

Rules:
- [Constraint 1]
- [Constraint 2]
- Do not include markdown fences or prose outside JSON.
`;

const userMessage = `[Contextual input]`;
const raw = await chatComplete(system, userMessage);
const parsed = extractJSON(raw);
const validated = Schema.parse(parsed);
```

### Error Handling Pattern

Nodes append to the reasoning trace even on failure, enabling debugging:

```typescript
async function node(state: ResearchState) {
  try {
    // ... main logic
    return { /* success state */ };
  } catch (error) {
    const reasoning = appendReasoning(state, {
      node: "node_name",
      summary: `Error: ${error.message}`,
    });
    return {
      status: "failed",
      errorMessage: error.message,
      reasoning,
    };
  }
}
```

## Routing Logic

### Conditional Edges

LangGraph `addConditionalEdges` accepts a router function that returns the next node name:

```typescript
graph.addConditionalEdges("auditor", routeAfterAudit, {
  thinker: "thinker",
  hitl_gate: "hitl_gate",
  [END]: END,
});
```

The mapping object defines legal transitions. If the router returns a key not in the map, LangGraph throws an error.

### Router Functions

Routers are pure functions that inspect state:

```typescript
function routeAfterAudit(state: ResearchState): "thinker" | "hitl_gate" | typeof END {
  // Safety ceiling check
  if (state.planRevisionCount >= state.maxPlanRevisions) {
    return END;
  }

  // Rejection triggers revision
  if (state.auditResult?.verdict !== "approved") {
    return "thinker";
  }

  // Approval proceeds to HITL
  return "hitl_gate";
}
```

## LLM Integration Layer

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     llm/index.ts                            │
├─────────────────────────────────────────────────────────────┤
│  Module-level State                                         │
│  ├── generatorPromise: Promise<TextGenerationPipeline>      │
│  ├── isModelLoaded: boolean                                 │
│  └── currentProgress: number                                │
├─────────────────────────────────────────────────────────────┤
│  Exports                                                    │
│  ├── loadModel(onProgress?) → Promise<Pipeline>             │
│  ├── chatComplete(system, user) → Promise<string>           │
│  ├── getModelStatus() → ModelProgress                       │
│  └── MODEL_ID: string                                       │
└─────────────────────────────────────────────────────────────┘
```

### Lazy Loading Pattern

The model is loaded once and reused across all requests:

```typescript
let generatorPromise: Promise<TextGenerationPipeline> | null = null;

export function loadModel(): Promise<TextGenerationPipeline> {
  if (generatorPromise) return generatorPromise; // Return cached promise

  generatorPromise = pipeline("text-generation", MODEL_ID, {
    progress_callback: handleProgress,
  });

  return generatorPromise;
}
```

### Progress Streaming

The Hugging Face Transformers library supports progress callbacks:

```typescript
pipeline("text-generation", MODEL_ID, {
  progress_callback: (data: { status: string; file?: string; progress?: number }) => {
    // data.status: "download", "progress", "ready"
    // data.file: current file being downloaded
    // data.progress: 0-1 fraction
  },
});
```

## API Design

### Research Streaming: Server-Sent Events (SSE)

Research results are streamed as **Server-Sent Events** so the client can distinguish event types and get low-latency, non-blocking updates. The response uses `Content-Type: text/event-stream` and each message has an `event` name plus a `data` payload (JSON).

**Why SSE (not NDJSON):** Standard SSE gives a single, well-understood protocol for streaming; event names (`start`, `research`, `error`) allow the client to handle each kind of message without guessing. Proxies and browsers handle SSE well, and we can add `ping`/`heartbeat` later without changing the wire format.

**Wire format:**

```
event: start
data: {"node":"_start","state":{"status":"started","plan":{...},"reasoning":[...]}}

event: research
data: {"node":"thinker","state":{"status":"thinking","plan":{...}}}

event: research
data: {"node":"auditor","state":{"status":"awaiting_approval","auditResult":{...}}}

event: research
data: {"node":"synthesizer","state":{"status":"complete","finalReport":"..."}}

event: error
data: {"node":"_error","state":{"status":"failed","errorMessage":"..."}}
```

**Server (route):** The route encodes each event with `event: <name>\ndata: <JSON>\n\n` and enqueues into a `ReadableStream`, then closes the stream when the graph run finishes or throws.

**Client:** The client reads the response body with `getReader()`, accumulates chunks, splits on `\n\n` to get full SSE messages, then for each message parses the `event:` line and the `data:` line (JSON). Events of type `research` (and `start`) are appended to the events list; the last event carrying `finalReport` is used to drive the word-by-word streaming animation in the chat.

### Model Loading Protocol

Model load also uses SSE for download progress:

```
data: {"status":"downloading","progress":25,"file":"model.onnx"}\n\n
data: {"status":"downloading","progress":50,"file":"model.onnx"}\n\n
data: {"status":"ready","progress":100,"modelId":"...","dtype":"q4"}\n\n
```

SSE format: `data: ` prefix, JSON body, double newline (`\n\n`) between events.

## Frontend Architecture

The workspace (`app/page.tsx`) is built for a Cursor/Gemini-like flow: immediate feedback, non-blocking streaming, and clear separation between chat, context, and observability.

### Layout and Responsibilities

| Area | Purpose |
|------|--------|
| **Chat** | User messages and assistant replies. Assistant messages show a shimmer placeholder while waiting, then the final report is revealed word-by-word for a live-conversation feel. |
| **Context panel** | Knowledge drop zone: drag-and-drop PDFs, notes, and URL references. Items are indexed in **IndexedDB** via `lib/knowledge` (browser embeddings + chunks); on submit, **`retrieve(query)`** runs client-side and the request sends **`retrievedContext`** + **`contextUrls`** to `POST /api/research`. |
| **Model card** | Model selection, load/progress, status pill (Ready / Loading / Error). Uses the same SSE pattern as model load API. |
| **Reasoning trace** | Scrollable list of the latest reasoning summaries per node so you can follow the graph’s flow while the chat shows the final answer. |

### Optimistic UI and Streaming Flow

1. **On submit:** The client immediately appends a user message and an assistant placeholder (with shimmer) to the chat and sets `isStreaming = true`. No wait for the first byte.
2. **SSE consumption:** `POST /api/research` is read with `response.body.getReader()`. Chunks are decoded and split on `\n\n`. Each SSE message is parsed for `event:` and `data:`; `start` and `research` events are appended to the events list.
3. **Final report:** When an event contains `state.finalReport`, that text is stored and a word-by-word animation is started for the latest assistant message: a timer (e.g. every 40ms) reveals the next word until the full report is shown, then `isStreaming` is cleared.
4. **Abort/cleanup:** A ref holds an `AbortController` for the in-flight request; starting a new run aborts the previous one and clears the streaming timer so only one “live” reply runs at a time.

### Client-side knowledge (browser “vector DB”)

RAG is implemented under **`lib/knowledge/`** and runs **only in the browser** (see README “Client-side knowledge store”).

- **Storage:** IndexedDB database `deeptrust-knowledge`: **`documents`** (id, type: file \| url \| note, label, optional url) and **`chunks`** (id, documentId, text, **embedding** float array, span indices). Index **`byDocument`** on chunks supports cascading delete.
- **Embeddings:** `@xenova/transformers` **`feature-extraction`** with **`Xenova/all-MiniLM-L6-v2`**, mean-pooled and normalized; **cosine similarity** in JS for scoring. Distinct from the server’s chat LLM (worker thread).
- **Ingestion:** PDFs → extract text → `chunkText` (~500 chars, overlap) → embed each chunk → persist. Notes → same. URLs → one chunk embedding `URL: …` (no network fetch of page body in v1).
- **Retrieval:** `retrieve(userQuery)` embeds the query, scores **all chunks**, returns **top-K** (8) concatenated as `retrievedContext` and deduped URL list as `contextUrls`.
- **API contract:** `POST /api/research` body includes `query`, **`retrievedContext`**, **`contextUrls`**. The route passes them into `runResearch` options → `ResearchState.knowledgeContext` / `contextUrls` for Thinker and Synthesizer. Original files are **not** uploaded—only retrieved snippet text crosses the wire.

### Quick Actions and Starter Cards

- **Quick-action chips** below the input (e.g. local knowledge + cited web results, approve-before-tools, auditable source trail, on-device vs network) set or extend the query and optionally trigger a run.
- **Starter cards** in the empty state show example prompts aligned with privacy-first research (e.g. local inference, verifiable sources) and populate the input or start a run when clicked.

### Why This Structure

- **Single page:** All controls (model, context, chat, trace) stay on one screen to reduce context switching and match a “flow state” tool.
- **SSE end-to-end:** Both research and model load use SSE so the client has one mental model: stream events, parse by type, update UI.
- **Word-by-word:** The synthesizer returns the full report in one event; animating it word-by-word on the client gives a streaming feel without changing the backend contract.

## File Organization

### Separation of Concerns

| Directory | Responsibility |
|-----------|----------------|
| `lib/agent/nodes/` | Individual node implementations |
| `lib/agent/llm/` | LLM client abstraction |
| `lib/agent/utils/` | Shared utilities (JSON extraction, policy loading) |
| `lib/agent/` | Graph construction, state schemas, routing |
| `lib/knowledge/` | Client-only RAG: IndexedDB, Xenova embeddings, chunking, retrieve (import from browser only) |
| `app/api/` | HTTP endpoints |
| `app/` | React UI components |

### Import Hierarchy

```
app/api/research/route.ts
└── @/lib/agent (public API)
    └── graph.ts
        ├── state.ts
        ├── nodes/index.ts
        │   ├── thinker.ts → llm, utils, state
        │   ├── auditor.ts → llm, utils, state
        │   └── ...
        └── routing.ts → state
```

## Checkpointing and Persistence

### MemorySaver (Development)

Default checkpointer stores state in memory. State is lost on server restart.

```typescript
import { MemorySaver } from "@langchain/langgraph";
const checkpointer = new MemorySaver();
```

### Production Persistence

For production, swap to a persistent checkpointer:

```typescript
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
const checkpointer = await PostgresSaver.fromConnString(process.env.DATABASE_URL);
```

### Thread-Based State

Each research session has a unique `threadId`. The checkpointer keys state by thread:

```typescript
const config = { configurable: { thread_id: initialState.threadId } };

// Stream with checkpointing
for await (const event of graph.stream(initialState, config)) { ... }

// Resume after HITL: pass a Command with `resume` so interrupt() in hitl_gate can proceed,
// and set humanApproved in the same step
for await (const event of graph.stream(
  new Command({ resume: true, update: { humanApproved: true } }),
  config
)) { ... }
```

## Security Considerations

### Policy Enforcement

The Auditor node validates plans against `POLICY.md` before execution. Policy rules should cover:

- Data access restrictions
- External request limits
- Allowed tool types
- Content guidelines

### Tool execution

- **`web_search`**: Fetches HTML results from DuckDuckGo by default (no API key). If `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_CX` are set, uses Google Custom Search JSON API instead. Timeouts and bounded result counts limit external HTTP usage.

Further hardening (rate limits, allowlists) can be added as deployment needs grow.

### Input Validation

All state mutations pass through Zod schemas, preventing malformed data from propagating.

---

## Future Considerations

### Potential Enhancements

1. **Persistent Checkpointing**: PostgreSQL or Redis for production state storage
2. **More tools**: Document fetch (e.g. Playwright), optional code execution, or alternate search backends (Tavily, SearXNG)
3. **Multi-Model Support**: Router to select appropriate model per task complexity
4. **Observability**: OpenTelemetry traces for node-level metrics
5. **Parallel Tool Execution**: Execute independent steps concurrently
