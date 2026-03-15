/**
 * Client-side knowledge store for RAG.
 * Use from "use client" components only (IndexedDB + Transformers.js run in browser).
 */

export type { KnowledgeDocument, KnowledgeChunk, KnowledgeItemMeta, RetrieveResult, DocumentType } from "./types";
export { listKnowledgeItems, addPdfFile, addNote, addUrl, removeKnowledgeDocument, retrieve } from "./store";
export { chunkText } from "./chunk";
export { extractTextFromPdf } from "./pdf";
export { embed, embedBatch, cosineSimilarity } from "./embeddings";
