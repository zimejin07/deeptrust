---
name: Client-side RAG knowledge upload
overview: "Implement the Context panel as a real client-side RAG flow: persist PDFs, notes, and URLs in IndexedDB, index them with in-browser embeddings and a vector store, retrieve relevant chunks at query time, and pass that context to the research agent so the LLM uses it when planning and synthesizing."
todos: []
isProject: false
---

# Client-Side RAG: Knowledge Upload and Retrieval

## Current state

- **Frontend** ([app/page.tsx](app/page.tsx)): The Context panel stores only metadata in React state (`KnowledgeItem`: id, type, label, meta). File content is never read; notes are plain text; URLs are just strings. No persistence, no embeddings, no retrieval.
- **API** ([app/api/research/route.ts](app/api/research/route.ts)): Reads only `query` from the body; `knowledge` is ignored.
- **Agent** ([lib/agent/graph.ts](lib/agent/graph.ts), [lib/agent/state.ts](lib/agent/state.ts)): `runResearch(userQuery, sessionName)` and `createInitialState({ threadId, userQuery, sessionName })`; no field for retrieved context. The Thinker builds the prompt from `state.userQuery` only ([lib/agent/nodes/thinker.ts](lib/agent/nodes/thinker.ts) line 117).

## Target flow

```mermaid
sequenceDiagram
  participant User
  participant UI
  participant IndexedDB
  participant VectorStore
  participant API
  participant Agent

  User->>UI: Add PDF / note / URL
  UI->>UI: Extract text (PDF: pdf.js; note: as-is; URL: see below)
  UI->>UI: Chunk and embed (browser)
  UI->>VectorStore: Store chunks + vectors in IndexedDB
  User->>UI: Run research
  UI->>VectorStore: Embed query; top-k similarity search
  UI->>API: POST { query, retrievedContext }
  API->>Agent: runResearch(query, { knowledgeContext })
  Agent->>Agent: Thinker / Synthesizer use knowledgeContext in prompts
```



## 1. Client: Storage, extraction, embedding, and retrieval

### 1.1 Persistence and data model

- Introduce a **client-side knowledge store** backed by **IndexedDB** (separate from the existing React state so refreshes and future sessions retain data).
- **Schema** (conceptual):  
  - **Documents**: `id`, `type` (file | url | note), `label`, `createdAt`, optional `url` for type url.  
  - **Chunks**: `id`, `documentId`, `text`, `embedding` (array of numbers), `startIndex`, `endIndex`.
- Use a single IndexedDB database (e.g. `deeptrust-knowledge`) with object stores for documents and chunks (or a library that wraps this).

### 1.2 Text extraction

- **PDFs**: Use **pdf.js** (Mozilla) in the browser to extract text from dropped/selected files. No server round-trip; keep PDFs client-side only.
- **Notes**: Use the note text as a single “document”; optional chunking by paragraph or fixed size.
- **URLs**: Two options (choose one for v1):
  - **A (recommended for scope)**  
  Store URL as metadata only. Do **not** fetch or embed URL content in the browser (avoids CORS and complexity). When building the research payload, send the list of “context URLs” with the request; the backend can pass them into the Thinker so the plan may include `document_fetch` steps for those URLs, or the Thinker can be prompted to consider “the user provided these URLs as references” in the plan.
  - **B (full client-side)**  
  Fetch URL in the browser (e.g. via a Next.js API route that proxies the fetch to avoid CORS), extract text (HTML → text), then chunk and embed like PDFs. Adds proxy and error handling.

Recommendation: **A** for the first iteration; document B as a follow-up.

### 1.3 Chunking and embedding in the browser

- **Chunking**: Split document text into overlapping or fixed-size segments (e.g. 256–512 tokens or ~500 chars with 50–100 char overlap). No server call.
- **Embeddings**: Use a **browser-run embedding model** so everything stays client-side:
  - **Option A**: **Transformers.js** (`@xenova/transformers`) with a small feature-extraction model (e.g. `Xenova/all-MiniLM-L6-v2` or similar). Runs in WebAssembly; single dependency consistent with “local-first”.
  - **Option B**: A dedicated client-side vector DB that includes embeddings (e.g. **idbvec** with external embeddings, or **entity-db** which uses Transformers.js under the hood). Prefer one that stores vectors in IndexedDB and supports similarity search.
- Store each chunk’s embedding in IndexedDB with a reference to its document and text.

### 1.4 Vector store and retrieval

- **Option A**: **idbvec** (`@brainwires/idbvec`): WASM + IndexedDB, HNSW index, configurable distance. You supply embeddings (e.g. from Transformers.js); idbvec handles storage and k-NN search.
- **Option B**: **Custom**: Store chunks (with embeddings) in IndexedDB; on query, load relevant chunks and run brute-force cosine similarity (or a tiny WASM k-NN) in a worker to avoid blocking the main thread. Good for small corpora (< ~10k chunks).
- At “Run research” time: embed the user query with the same model, run top-k similarity search (e.g. k = 5–10), build a single `retrievedContext` string (e.g. concatenate chunk texts with source labels) and send it with the request.

### 1.5 UI and sync with existing Context panel

- Keep the existing **Context panel** UX: drag-and-drop, “Attach files”, URL input, “Short note”, and the list of items.
- **On add**:
  - For **files** (PDF): read file, extract text with pdf.js, chunk, embed, and write documents + chunks (+ vectors) to IndexedDB. Add a corresponding entry to React state for the list (label, type, id) and optionally sync the list from IndexedDB on load.
  - For **notes**: create one document, chunk if needed, embed, store; update UI list.
  - For **URLs** (v1): store URL in IndexedDB as a document with no chunks (or a single placeholder chunk with URL as “text”); backend will receive “context URLs” and can use them in the prompt or in plan steps.
- **On remove**: Delete document (and its chunks) from IndexedDB and from React state. Add a remove control next to each item in the list (currently there is none).
- **On load**: Hydrate the Context list from IndexedDB so persisted knowledge survives refresh.

## 2. Backend: Accept and use retrieved context

### 2.1 Research API

- In [app/api/research/route.ts](app/api/research/route.ts), read from the request body: `query` and either `retrievedContext` (string) or `knowledge` (array or object that includes `retrievedContext` and optionally `contextUrls: string[]`).
- Call the agent with this context, e.g. `runResearch(query, sessionName, { retrievedContext, contextUrls })`.

### 2.2 Agent state and graph

- In [lib/agent/state.ts](lib/agent/state.ts), add an optional field to `ResearchState`, e.g.  
`knowledgeContext: z.string().optional()`  
and optionally `contextUrls: z.array(z.string()).optional()`.
- In [lib/agent/graph.ts](lib/agent/graph.ts), add the new channel(s) to the state graph (e.g. `knowledgeContext: { value: (_, n) => n }`) and ensure they are part of the initial state when provided.
- Extend [lib/agent/state.ts](lib/agent/state.ts) `createInitialState` to accept optional `knowledgeContext` (and `contextUrls` if used), and pass them through in [lib/agent/graph.ts](lib/agent/graph.ts) when calling `createInitialState` and streaming.

### 2.3 Thinker and Synthesizer

- In [lib/agent/nodes/thinker.ts](lib/agent/nodes/thinker.ts), when building the user message (around line 117), if `state.knowledgeContext` is present, append it to the prompt, e.g.  
“The user provided the following retrieved context from their local knowledge base. Use it to inform the plan and prefer steps that leverage this context where relevant:\n\n” + state.knowledgeContext.  
If `state.contextUrls` is used, add a line like “The user also referenced these URLs: …” so the Thinker can emit `document_fetch` steps for them.
- In [lib/agent/nodes/synthesizer.ts](lib/agent/nodes/synthesizer.ts), if `state.knowledgeContext` is present, include it in the context passed to the LLM when synthesizing the final report (so the report can cite or summarize the user’s local knowledge).

## 3. Dependencies and build

- Add npm packages: e.g. **pdfjs-dist** (or **react-pdf** if you prefer a React wrapper) for PDF text extraction; **@xenova/transformers** (or the chosen embedding solution); and **idbvec** or a minimal IndexedDB + vector search helper.
- Ensure the embedding model is loaded only when the user first adds knowledge (or on first “Run research” with non-empty context) to avoid blocking initial page load; consider a small “Preparing knowledge…” state in the UI when the embedding pipeline is loading.

## 4. Scope summary


| Area    | In scope                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client  | IndexedDB persistence for documents/chunks; PDF text extraction (pdf.js); notes as documents; URLs stored as references (no client fetch in v1).                                                                             |
| Client  | Browser embeddings (Transformers.js or equivalent); vector store in IndexedDB (idbvec or custom); top-k retrieval at query time; send `retrievedContext` (+ optional `contextUrls`) with POST /api/research.                 |
| Client  | Context panel: remove item; hydrate list from IndexedDB on load; show “indexed” or “ready” per item after processing.                                                                                                        |
| Backend | Research route parses `retrievedContext` (and optional `contextUrls`); runResearch(..., { knowledgeContext, contextUrls }); state + createInitialState + graph channels; Thinker and Synthesizer include context in prompts. |


## 5. Files to add or touch

- **New**: `lib/knowledge/` (or `app/lib/knowledge/`) — IndexedDB schema, chunking, embedding pipeline (or wrapper around Transformers.js + idbvec), and retrieval function. Keep it UI-agnostic so it can be called from the Context panel and before `fetch('/api/research')`.
- **New** (optional): `app/components/KnowledgePanel.tsx` — Extract the Context panel into a component that uses the knowledge store and exposes “items” + “retrievedContext” for the parent.
- **Edit**: [app/page.tsx](app/page.tsx) — Wire file drop/note/URL to the knowledge store; before runResearch, call retrieval and send `retrievedContext` (and `contextUrls`) in the request body; add remove button; hydrate from IndexedDB.
- **Edit**: [app/api/research/route.ts](app/api/research/route.ts) — Read `retrievedContext` / `contextUrls`; pass to runResearch.
- **Edit**: [lib/agent/state.ts](lib/agent/state.ts) — Add `knowledgeContext` (and optionally `contextUrls`); extend `createInitialState`.
- **Edit**: [lib/agent/graph.ts](lib/agent/graph.ts) — Add channel(s); pass context into `createInitialState` in runResearch.
- **Edit**: [lib/agent/nodes/thinker.ts](lib/agent/nodes/thinker.ts) — Include `state.knowledgeContext` (and URLs) in the Thinker prompt.
- **Edit**: [lib/agent/nodes/synthesizer.ts](lib/agent/nodes/synthesizer.ts) — Include `state.knowledgeContext` in the synthesis prompt.
- **Edit**: [lib/agent/index.ts](lib/agent/index.ts) — Export any new types if needed; ensure runResearch signature is updated and documented.

## 6. Optional follow-ups

- **URL content in browser**: Proxy fetch in an API route; extract text; chunk and embed like PDFs so URL content is fully in the vector store.
- **Delete-all / export**: Clear all knowledge from IndexedDB; export documents/chunks as JSON.
- **Progress UX**: Show “Extracting…”, “Embedding…”, “Indexed” per file so large PDFs don’t look stuck.

