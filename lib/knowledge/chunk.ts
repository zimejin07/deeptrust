/**
 * Text chunking for RAG. Fixed-size segments with overlap.
 */

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_OVERLAP = 80;

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP
): { text: string; startIndex: number; endIndex: number }[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: { text: string; startIndex: number; endIndex: number }[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + chunkSize, trimmed.length);
    if (end < trimmed.length) {
      const lastSpace = trimmed.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }
    const slice = trimmed.slice(start, end);
    if (slice.length > 0) {
      chunks.push({ text: slice, startIndex: start, endIndex: end });
    }
    start = end - (end < trimmed.length ? overlap : 0);
    if (start >= end) start = end;
  }

  return chunks;
}
