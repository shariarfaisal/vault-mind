// Deep research sub-loop: a focused, contained agent that plans, gathers from the
// web AND the vault, curates findings without drifting, and writes a cited report
// note. Isolated from the main agent loop — its own state, prompts, and budget.
// See docs/superpowers/specs/2026-06-15-research-agent-design.md.

import { ChatMessage, Usage } from "../types";
import { streamCompletion } from "../llm/openrouter";
import { runTool, ToolContext } from "./tools";

interface Finding {
  n: number; // citation index
  claim: string;
  source: string; // URL or vault note path
  sourceType: "url" | "note";
  snippet: string;
}

// Pull the first JSON value out of a model response (handles ```json fences / prose).
function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "research";
}

// Extract result URLs from web_search output ("1. title\nURL\nsnippet").
function urlsFromSearch(out: string, max: number): string[] {
  const urls = (out.match(/https?:\/\/[^\s)]+/g) || []).filter((u) => !/duckduckgo\.com/.test(u));
  return [...new Set(urls)].slice(0, max);
}

export async function runResearch(ctx: ToolContext, query: string, depth?: number): Promise<string> {
  const model = ctx.settings.researchModel || ctx.settings.model;
  const apiKey = ctx.settings.apiKey;
  const signal = ctx.signal || new AbortController().signal; // honor Stop if the host provides a signal
  const maxSteps = Math.max(1, depth || ctx.settings.maxResearchSteps || 15);
  const step = (label: string) => ctx.onResearchStep?.(label);

  if (!apiKey) return "Error: no OpenRouter API key set.";

  // Small LLM helper that accumulates token/cost usage back into the turn.
  const ask = async (messages: ChatMessage[], temperature = 0.2): Promise<string> => {
    const res = await streamCompletion({ apiKey, model, messages, temperature, signal });
    ctx.onUsage?.(res.usage);
    return res.content || "";
  };

  // ---- Phase 1: Plan ----
  step("Planning research…");
  const planRaw = await ask([
    {
      role: "system",
      content:
        "You are a research planner. Break the user's topic into 3-6 focused, non-overlapping sub-questions that together fully answer it. Output ONLY a JSON array of strings.",
    },
    { role: "user", content: query },
  ], 0);
  let plan = extractJson<string[]>(planRaw) || [];
  plan = plan.filter((s) => typeof s === "string" && s.trim()).slice(0, 6);
  if (!plan.length) plan = [query]; // fall back to the raw question

  // ---- Phase 2: Gather (bounded) ----
  const goal = query; // frozen — re-injected every step so the loop can't drift
  const findings: Finding[] = [];
  const sourceIndex = new Map<string, number>();
  const indexOf = (source: string): number => {
    const existing = sourceIndex.get(source);
    if (existing) return existing;
    const n = sourceIndex.size + 1;
    sourceIndex.set(source, n);
    return n;
  };

  const subQuestions = plan.slice(0, maxSteps);
  for (let i = 0; i < subQuestions.length; i++) {
    if (signal.aborted) break; // Stop pressed — synthesize from what we have
    const subq = subQuestions[i];
    step(`Researching (${i + 1}/${subQuestions.length}): ${subq}`);

    // Gather from both channels.
    const web = await runTool(ctx, "web_search", JSON.stringify({ query: subq, count: 5 }));
    const vault = await runTool(ctx, "search_vault", JSON.stringify({ query: subq }));

    // Fetch the top web pages for fuller context.
    let pages = "";
    for (const url of urlsFromSearch(web, 2)) {
      const page = await runTool(ctx, "fetch_url", JSON.stringify({ url }));
      pages += `\n\nSOURCE_URL: ${url}\n${page.slice(0, 4000)}`;
    }

    // Curate: extract grounded findings for THIS sub-question only.
    const material = `WEB RESULTS:\n${web}\n\nFETCHED PAGES:${pages || " (none)"}\n\nVAULT NOTES:\n${vault}`;
    const raw = await ask([
      {
        role: "system",
        content:
          "You curate research evidence. Given the material, extract up to 3 findings that DIRECTLY answer the sub-question. Each finding must be grounded in the material — never invent. Output ONLY a JSON array of objects: {\"claim\": string, \"source\": string (the URL or vault note path it came from), \"sourceType\": \"url\"|\"note\", \"snippet\": string (short supporting excerpt)}. If nothing relevant, output [].",
      },
      {
        role: "user",
        content: `Overall goal: ${goal}\nSub-question: ${subq}\n\n${material.slice(0, 16000)}`,
      },
    ], 0);
    const extracted = extractJson<Array<Omit<Finding, "n">>>(raw) || [];
    for (const f of extracted) {
      if (!f || !f.claim || !f.source) continue;
      findings.push({
        n: indexOf(f.source),
        claim: String(f.claim),
        source: String(f.source),
        sourceType: f.sourceType === "note" ? "note" : "url",
        snippet: String(f.snippet || ""),
      });
    }
  }

  if (!findings.length) {
    return `Researched "${goal}" but found no groundable evidence across the web or your vault. Try rephrasing, or check your connection.`;
  }

  // ---- Phase 3: Synthesize (grounded in findings only) ----
  step("Synthesizing report…");
  const findingsBlock = findings
    .map((f) => `[${f.n}] (${f.sourceType}: ${f.source}) ${f.claim}${f.snippet ? `\n    “${f.snippet}”` : ""}`)
    .join("\n");
  const report = await ask([
    {
      role: "system",
      content:
        "You are a research writer. Using ONLY the findings provided, write a clear, structured markdown report that answers the goal. Use an executive summary then thematic sections. Cite every claim with its [N] index. Do NOT invent facts or citations beyond the findings. End with nothing — sources are appended separately.",
    },
    { role: "user", content: `Goal: ${goal}\n\nFindings:\n${findingsBlock}` },
  ], 0.3);

  // Build the Sources list from the registry (URL links, vault [[wikilinks]]).
  const sources = [...sourceIndex.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([source, n]) => {
      const isNote = findings.find((f) => f.source === source)?.sourceType === "note";
      const ref = isNote ? `[[${source.replace(/\.md$/, "")}]]` : source;
      return `${n}. ${ref}`;
    })
    .join("\n");

  const noteBody = `# Research: ${goal}\n\n> Generated by Vault Mind · ${findings.length} findings · ${sourceIndex.size} sources\n\n${report.trim()}\n\n## Sources\n\n${sources}\n`;

  // ---- Phase 4: Write the report note ----
  const path = `${ctx.settings.researchFolder || "Research"}/${slugify(goal)}.md`;
  const writeResult = await runTool(ctx, "create_note", JSON.stringify({ path, content: noteBody }));
  step("Done.");

  if (writeResult.startsWith("Error") || writeResult.startsWith("Writes are disabled")) {
    // Couldn't persist (writes off / declined) — still return the synthesis inline.
    return `Research complete (note not saved: ${writeResult}).\n\n${report.trim()}\n\n## Sources\n${sources}`;
  }
  return `Research complete. Wrote report to [[${path.replace(/\.md$/, "")}]] — ${findings.length} findings from ${sourceIndex.size} sources.`;
}
