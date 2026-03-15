/**
 * PDF text extraction in the browser using pdfjs-dist.
 * Only runs client-side.
 */

export async function extractTextFromPdf(file: File): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("PDF extraction is only available in the browser");
  }
  const pdfjsLib = await import("pdfjs-dist");
  const GlobalWorkerOptions = (pdfjsLib as unknown as { GlobalWorkerOptions?: { workerSrc: string } }).GlobalWorkerOptions;
  if (GlobalWorkerOptions && !GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  }
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = doc.numPages;
  const parts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("");
    parts.push(text);
  }
  return parts.join("\n\n").trim();
}
