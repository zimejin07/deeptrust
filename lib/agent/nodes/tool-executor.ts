/**
 * Tool Executor Node — executes research plan steps
 */

import { ResearchState, ResearchPlan, ResearchStep, appendReasoning } from "../state";

/**
 * Executes one step at a time (the step at `currentStepIndex`).
 * After each execution the graph loops back through the router;
 * when all steps are complete it advances to synthesizer.
 */
export async function toolExecutorNode(
  state: ResearchState
): Promise<Partial<ResearchState>> {
  if (!state.plan) throw new Error("toolExecutorNode called with no plan");

  const step = state.plan.steps[state.currentStepIndex];
  if (!step) throw new Error(`No step at index ${state.currentStepIndex}`);

  const output = await dispatchTool(step.tool, step.input);

  const updatedSteps = state.plan.steps.map((s, i) =>
    i === state.currentStepIndex
      ? { ...s, output, executedAt: new Date().toISOString() }
      : s
  );

  const updatedPlan = ResearchPlan.parse({
    ...state.plan,
    steps: updatedSteps,
  });

  const reasoning = appendReasoning(state, {
    node: "tool_executor",
    summary: `Executed step ${state.currentStepIndex + 1}/${state.plan.steps.length}: [${step.tool}] "${step.input.slice(0, 80)}…"`,
    rawThought: output,
  });

  return {
    plan: updatedPlan,
    currentStepIndex: state.currentStepIndex + 1,
    status: "executing",
    reasoning,
    updatedAt: new Date().toISOString(),
  };
}

async function dispatchTool(
  tool: ResearchStep["tool"],
  input: string
): Promise<string> {
  switch (tool) {
    case "web_search":
      return webSearch(input);
    default: {
      const _exhaustive: never = tool;
      throw new Error(`Unknown tool: ${_exhaustive}`);
    }
  }
}

// ─── Web Search ──────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Search the web using Google Custom Search (if configured) or
 * DuckDuckGo HTML as a zero-config fallback.
 */
async function webSearch(query: string): Promise<string> {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;

  const results =
    apiKey && cx
      ? await googleCseSearch(query, apiKey, cx)
      : await duckDuckGoSearch(query);

  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }

  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
    .join("\n\n");
}

async function googleCseSearch(
  query: string,
  apiKey: string,
  cx: string
): Promise<SearchResult[]> {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(MAX_RESULTS));

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    console.error(`Google CSE error ${res.status}, falling back to DuckDuckGo`);
    return duckDuckGoSearch(query);
  }

  const data = (await res.json()) as {
    items?: { title: string; link: string; snippet: string }[];
  };

  return (data.items ?? []).slice(0, MAX_RESULTS).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
  }));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/");
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; DeepTrust/1.0; +https://github.com/deeptrust)",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    console.error(`DuckDuckGo returned ${res.status}`);
    return [];
  }

  const html = await res.text();

  const results: SearchResult[] = [];
  const resultBlocks = html.split(/class="result\s/);

  for (const block of resultBlocks.slice(1)) {
    if (results.length >= MAX_RESULTS) break;

    const urlMatch = block.match(/href="([^"]+)"/);
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/
    );

    const rawUrl = urlMatch?.[1] ?? "";
    // DuckDuckGo wraps URLs in a redirect; extract the real URL
    const realUrlMatch = rawUrl.match(/uddg=([^&]+)/);
    const finalUrl = realUrlMatch
      ? decodeURIComponent(realUrlMatch[1])
      : rawUrl;

    if (!finalUrl || finalUrl.startsWith("/") || !titleMatch) continue;

    results.push({
      title: decodeHtmlEntities(stripHtmlTags(titleMatch[1]).trim()),
      url: finalUrl,
      snippet: snippetMatch
        ? decodeHtmlEntities(stripHtmlTags(snippetMatch[1]).trim())
        : "",
    });
  }

  return results;
}
