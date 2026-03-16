# DeepTrust — Agent context

**What this is:** TypeScript research agent (LangGraph state graph + local LLM + Next.js). Plan → audit → tools → synthesize. Real-time workspace UI with SSE streaming and context/knowledge upload.

**Where the truth lives:** Structure and features change over time. Prefer these for current details:
- **README.md** — Overview, stack, project structure, API, frontend, run/config.
- **docs/ARCHITECTURE.md** — Low-level design: state machine, nodes, routing, LLM layer, SSE protocol, frontend architecture.

**Rough layout (may evolve):**
- `lib/agent/` — Graph, state, nodes, LLM client (worker thread), utils.
- `app/` — Next.js app; `page.tsx` = workspace UI; `app/api/` = research + model endpoints.
- `dist/llm/` — Built worker (from `npm run build:worker`).

**Commands:** `npm run build:worker` before first run; `npm run dev` to develop; `npm run build` then `npm run start` for production.

**When editing:** Follow existing patterns in the area you change. For agent graph or state, check `lib/agent/state.ts` and `lib/agent/graph.ts`; for API/streaming, see the route handlers and README/ARCHITECTURE.
