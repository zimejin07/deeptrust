/**
 * Client-side knowledge store types.
 * Documents and chunks are persisted in IndexedDB.
 */

export type DocumentType = "file" | "url" | "note";

export interface KnowledgeDocument {
  id: string;
  type: DocumentType;
  label: string;
  url?: string;
  createdAt: string;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  text: string;
  embedding: number[];
  startIndex: number;
  endIndex: number;
}

/** UI-facing item (matches existing KnowledgeItem shape). */
export interface KnowledgeItemMeta {
  id: string;
  type: DocumentType;
  label: string;
  meta?: string;
  status?: "pending" | "indexing" | "indexed" | "error";
}

export interface RetrieveResult {
  retrievedContext: string;
  contextUrls: string[];
}
