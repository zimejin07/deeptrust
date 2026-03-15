/**
 * High-level knowledge store: add documents, remove, list, retrieve.
 * Coordinates IndexedDB, chunking, PDF extraction, and embeddings.
 */

import { v4 as uuidv4 } from "uuid";
import type { KnowledgeDocument, KnowledgeChunk, KnowledgeItemMeta, RetrieveResult } from "./types";
import { openDB, putDocument, putChunks, listDocuments, deleteDocument, getAllChunks } from "./db";
import { chunkText } from "./chunk";
import { extractTextFromPdf } from "./pdf";
import { embed, cosineSimilarity } from "./embeddings";

const TOP_K = 8;

function docToMeta(doc: KnowledgeDocument): KnowledgeItemMeta {
  return {
    id: doc.id,
    type: doc.type,
    label: doc.label,
    meta: doc.type === "file" ? undefined : doc.url,
    status: "indexed",
  };
}

/** List all documents as UI items. */
export async function listKnowledgeItems(): Promise<KnowledgeItemMeta[]> {
  const docs = await listDocuments();
  return docs.map(docToMeta);
}

/** Add a PDF file: extract text, chunk, embed, store. */
export async function addPdfFile(file: File): Promise<KnowledgeItemMeta> {
  const text = await extractTextFromPdf(file);
  const id = uuidv4();
  const doc: KnowledgeDocument = {
    id,
    type: "file",
    label: file.name,
    createdAt: new Date().toISOString(),
  };
  await putDocument(doc);
  const chunks = chunkText(text);
  const chunksWithEmbeddings: KnowledgeChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const embedding = await embed(ch.text);
    chunksWithEmbeddings.push({
      id: `${id}-chunk-${i}`,
      documentId: id,
      text: ch.text,
      embedding,
      startIndex: ch.startIndex,
      endIndex: ch.endIndex,
    });
  }
  await putChunks(chunksWithEmbeddings);
  return docToMeta(doc);
}

/** Add a note: chunk, embed, store. */
export async function addNote(label: string): Promise<KnowledgeItemMeta> {
  const id = uuidv4();
  const doc: KnowledgeDocument = {
    id,
    type: "note",
    label: label.slice(0, 80) + (label.length > 80 ? "…" : ""),
    createdAt: new Date().toISOString(),
  };
  await putDocument(doc);
  const chunks = chunkText(label);
  const chunksWithEmbeddings: KnowledgeChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const embedding = await embed(ch.text);
    chunksWithEmbeddings.push({
      id: `${id}-chunk-${i}`,
      documentId: id,
      text: ch.text,
      embedding,
      startIndex: ch.startIndex,
      endIndex: ch.endIndex,
    });
  }
  if (chunksWithEmbeddings.length === 0) {
    const embedding = await embed(label);
    chunksWithEmbeddings.push({
      id: `${id}-chunk-0`,
      documentId: id,
      text: label,
      embedding,
      startIndex: 0,
      endIndex: label.length,
    });
  }
  await putChunks(chunksWithEmbeddings);
  return docToMeta(doc);
}

/** Add a URL as reference (no fetch in v1). Stored as document with one placeholder chunk so we can return contextUrls. */
export async function addUrl(url: string): Promise<KnowledgeItemMeta> {
  const id = uuidv4();
  const doc: KnowledgeDocument = {
    id,
    type: "url",
    label: url,
    url,
    createdAt: new Date().toISOString(),
  };
  await putDocument(doc);
  const embedding = await embed(`URL: ${url}`);
  await putChunks([
    {
      id: `${id}-chunk-0`,
      documentId: id,
      text: url,
      embedding,
      startIndex: 0,
      endIndex: url.length,
    },
  ]);
  return docToMeta(doc);
}

/** Remove a document and all its chunks. */
export async function removeKnowledgeDocument(id: string): Promise<void> {
  await deleteDocument(id);
}

/** Retrieve relevant context for a query: embed query, top-k similarity, build retrievedContext + contextUrls. */
export async function retrieve(query: string): Promise<RetrieveResult> {
  const chunks = await getAllChunks();
  if (chunks.length === 0) {
    return { retrievedContext: "", contextUrls: [] };
  }
  const docs = await listDocuments();
  const docMap = new Map(docs.map((d) => [d.id, d]));
  const queryEmbedding = await embed(query);
  const withScore = chunks.map((ch) => ({
    chunk: ch,
    score: cosineSimilarity(ch.embedding, queryEmbedding),
  }));
  withScore.sort((a, b) => b.score - a.score);
  const top = withScore.slice(0, TOP_K);
  const parts: string[] = [];
  const urlSet = new Set<string>();
  for (const { chunk } of top) {
    const doc = docMap.get(chunk.documentId);
    const source = doc ? doc.label : "Unknown";
    parts.push(`[${source}]\n${chunk.text}`);
    if (doc?.type === "url" && doc.url) urlSet.add(doc.url);
  }
  return {
    retrievedContext: parts.join("\n\n"),
    contextUrls: Array.from(urlSet),
  };
}
