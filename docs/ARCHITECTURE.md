# DeepTrust Architecture

This document provides a detailed technical overview of the DeepTrust Research Agent architecture, covering the state machine design, data flow, and implementation patterns.

## System Overview

DeepTrust is a research automation system that orchestrates an LLM through a multi-stage workflow. The system decomposes research questions into executable plans, validates them against policy, executes tool calls, and synthesizes results into reports.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Model Load  │  │ Query Input │  │ Event Stream│  │ Report View │        │
│  │   Status    │  │             │  │   Display   │  │             │        │
│  └──────┬──────┘  └──────┬──────┘  └──────▲──────┘  └─────────────┘        │
└─────────┼────────────────┼────────────────┼────────────────────────────────┘
          │                │                │
          ▼                ▼                │
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API LAYER                                      │
│  ┌─────────────────────┐  ┌─────────────────────────────────────┐          │
│  │ GET /api/model/load │  │ POST /api/research                  │          │
│  │ (SSE progress)      │  │ (NDJSON streaming)                  │          │
│  └─────────┬───────────┘  └─────────────────┬───────────────────┘          │
└────────────┼────────────────────────────────┼──────────────────────────────┘
             │                                │
             ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AGENT CORE                                     │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐  │
│  │   LLM Client    │  │              StateGraph                         │  │
│  │  (HF Transforms)│  │  ┌─────────┐  ┌─────────┐  ┌──────────────┐    │  │
│  │                 │◄─┼──│ Thinker │──│ Auditor │──│ Tool Executor│    │  │
│  │  - loadModel()  │  │  └────▲────┘  └────┬────┘  └──────┬───────┘    │  │
│  │  - chatComplete()│ │       │            │               │            │  │
│  └─────────────────┘  │       └────────────┘               ▼            │  │
│                       │                            ┌───────────────┐    │  │
│                       │                            │  Synthesizer  │    │  │
│                       │                            └───────────────┘    │  │
│                       └─────────────────────────────────────────────────┘  │
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
| `reasoning` | Append | Accumulates full reasoning trace |
| All others | Replace | Last-write-wins for scalar values |

```typescript
channels: {
  reasoning: {
    value: (existing, incoming) => [...(existing ?? []), ...(incoming ?? [])],
    default: () => [],
  },
  plan: { value: (_, n) => n },
  // ...
}
```

## Data Schemas

### Type System Philosophy

All data structures use Zod for runtime validation. TypeScript types are inferred from Zod schemas, ensuring a single source of truth.

```typescript
// Schema definition
export const ResearchStep = z.object({
  id: z.string().uuid(),
  tool: z.enum(["web_search", "document_fetch", "code_interpreter", "summarize"]),
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

### Streaming Protocol

Research results stream as newline-delimited JSON (NDJSON):

```
{"node":"thinker","state":{"status":"thinking","plan":{...}}}\n
{"node":"auditor","state":{"status":"awaiting_approval","auditResult":{...}}}\n
{"node":"synthesizer","state":{"status":"complete","finalReport":"..."}}\n
```

Client-side parsing:

```typescript
const lines = buffer.split("\n");
for (const line of lines) {
  if (line.trim()) {
    const event = JSON.parse(line);
    // Process event
  }
}
```

### Model Loading Protocol

Uses Server-Sent Events (SSE) for download progress:

```
data: {"status":"downloading","progress":25,"file":"model.onnx"}\n\n
data: {"status":"downloading","progress":50,"file":"model.onnx"}\n\n
data: {"status":"ready","progress":100}\n\n
```

SSE format requires `data: ` prefix and double newline suffix.

## File Organization

### Separation of Concerns

| Directory | Responsibility |
|-----------|----------------|
| `lib/agent/nodes/` | Individual node implementations |
| `lib/agent/llm/` | LLM client abstraction |
| `lib/agent/utils/` | Shared utilities (JSON extraction, policy loading) |
| `lib/agent/` | Graph construction, state schemas, routing |
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

// Resume from checkpoint
await graph.updateState(config, { humanApproved: true });
for await (const event of graph.stream(null, config)) { ... }
```

## Security Considerations

### Policy Enforcement

The Auditor node validates plans against `POLICY.md` before execution. Policy rules should cover:

- Data access restrictions
- External request limits
- Allowed tool types
- Content guidelines

### Tool Sandboxing

Tool implementations (currently stubs) should sandbox external operations:

- Network requests: Rate limiting, allowlists
- Code execution: Containerized environments
- File access: Scoped to specific directories

### Input Validation

All state mutations pass through Zod schemas, preventing malformed data from propagating.

---

## Future Considerations

### Potential Enhancements

1. **Persistent Checkpointing**: PostgreSQL or Redis for production state storage
2. **Tool Implementations**: Real web search (Tavily), document fetch (Playwright), code execution
3. **Multi-Model Support**: Router to select appropriate model per task complexity
4. **Observability**: OpenTelemetry traces for node-level metrics
5. **Parallel Tool Execution**: Execute independent steps concurrently
