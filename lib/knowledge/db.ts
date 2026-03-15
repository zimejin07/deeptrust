/**
 * IndexedDB schema and access for the knowledge store.
 * Database: deeptrust-knowledge
 * Stores: documents, chunks
 */

import type { KnowledgeDocument, KnowledgeChunk } from "./types";

const DB_NAME = "deeptrust-knowledge";
const DB_VERSION = 1;
const STORE_DOCUMENTS = "documents";
const STORE_CHUNKS = "chunks";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB is only available in the browser"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: "id" });
        chunkStore.createIndex("byDocument", "documentId", { unique: false });
      }
    };
  });
  return dbPromise;
}

export async function putDocument(doc: KnowledgeDocument): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, "readwrite");
    tx.objectStore(STORE_DOCUMENTS).put(doc);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDocument(id: string): Promise<KnowledgeDocument | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, "readonly");
    const req = tx.objectStore(STORE_DOCUMENTS).get(id);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listDocuments(): Promise<KnowledgeDocument[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, "readonly");
    const req = tx.objectStore(STORE_DOCUMENTS).getAll();
    tx.oncomplete = () => resolve(req.result ?? []);
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCUMENTS, STORE_CHUNKS], "readwrite");
    const docStore = tx.objectStore(STORE_DOCUMENTS);
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    docStore.delete(id);
    const index = chunkStore.index("byDocument");
    const range = IDBKeyRange.only(id);
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putChunks(chunks: KnowledgeChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, "readwrite");
    const store = tx.objectStore(STORE_CHUNKS);
    for (const chunk of chunks) store.put(chunk);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllChunks(): Promise<KnowledgeChunk[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, "readonly");
    const req = tx.objectStore(STORE_CHUNKS).getAll();
    tx.oncomplete = () => resolve(req.result ?? []);
    tx.onerror = () => reject(tx.error);
  });
}
