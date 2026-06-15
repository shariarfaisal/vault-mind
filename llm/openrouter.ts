// OpenRouter client: model discovery + streaming chat completions with tool calling.
// Docs: https://openrouter.ai/docs/guides/features/tool-calling

import { ChatMessage, ToolSchema, ToolCall, OpenRouterModel, CompletionResult, Usage } from "../types";

const BASE = "https://openrouter.ai/api/v1";
const REFERER = "https://obsidian.md";
const TITLE = "Vault Mind";

export interface StreamHandlers {
  onToken?: (t: string) => void; // streamed assistant text
  onToolStart?: (name: string) => void; // a tool call was requested
}

// Fetch OpenRouter models. toolsOnly => only tool-capable; freeOnly => only $0 models.
// Tool-capable models are sorted first (agent needs tool calling to work well).
export async function fetchModels(
  apiKey: string,
  opts: { toolsOnly?: boolean; freeOnly?: boolean } = {}
): Promise<OpenRouterModel[]> {
  const url = opts.toolsOnly ? `${BASE}/models?supported_parameters=tools` : `${BASE}/models`;
  const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) throw new Error(`Model list failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  let models: OpenRouterModel[] = json.data || [];
  if (opts.freeOnly) models = models.filter((m) => isFree(m));
  models.sort((a, b) => {
    const at = supportsTools(a) ? 0 : 1;
    const bt = supportsTools(b) ? 0 : 1;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
  return models;
}

export function supportsTools(m: OpenRouterModel): boolean {
  return !!m.supported_parameters?.includes("tools");
}

// Turn an OpenRouter error body into a short, human message.
function parseError(status: number, bodyText: string): string {
  try {
    const j = JSON.parse(bodyText);
    let msg: string = j.error?.message || "";
    const raw = j.error?.metadata?.raw;
    if (raw) {
      try {
        const r = typeof raw === "string" ? JSON.parse(raw) : raw;
        const inner = r.error?.message || (Array.isArray(r) ? r[0]?.message : "");
        if (inner) msg = inner;
      } catch {
        if (typeof raw === "string") msg = raw;
      }
    }
    if (status === 429 || /rate.?limit/i.test(msg)) {
      return `Model rate-limited. Try again, pick another model, or add your own provider key. (${msg.slice(0, 140)})`;
    }
    return msg ? `OpenRouter ${status}: ${msg.slice(0, 200)}` : `OpenRouter error ${status}`;
  } catch {
    return `OpenRouter ${status}: ${bodyText.slice(0, 160) || "request failed"}`;
  }
}

export function isFree(m: OpenRouterModel): boolean {
  if (m.id.endsWith(":free")) return true;
  const p = m.pricing;
  if (!p) return false;
  return Number(p.prompt || "0") === 0 && Number(p.completion || "0") === 0;
}

// Streaming chat completion. Accumulates streamed text + tool-call deltas.
export async function streamCompletion(
  opts: {
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    signal?: AbortSignal;
  },
  handlers: StreamHandlers = {}
): Promise<CompletionResult> {
  if (!opts.apiKey) throw new Error("No OpenRouter API key set. Add it in Vault Mind settings.");

  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools && opts.tools.length ? opts.tools : undefined,
    temperature: opts.temperature ?? 0.2,
    stream: true,
    usage: { include: true }, // ask OpenRouter to return token + cost accounting
  });

  // Send with limited retry on transient errors (429 rate-limit, 5xx).
  let res: Response | null = null;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": REFERER, "X-Title": TITLE },
      body,
      signal: opts.signal,
    });
    if (res.ok && res.body) break;
    const text = await res.text().catch(() => "");
    const transient = res.status === 429 || res.status >= 500 || /rate.?limit/i.test(text);
    if (transient && attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    throw new Error(parseError(res.status, text));
  }
  if (!res || !res.ok || !res.body) throw new Error("OpenRouter: no response.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
  // accumulate tool calls by index
  const toolAcc: Record<number, ToolCall> = {};
  const announced = new Set<number>();

  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // partial / keepalive
    }
    if (json.usage) {
      usage.prompt_tokens = json.usage.prompt_tokens ?? usage.prompt_tokens;
      usage.completion_tokens = json.usage.completion_tokens ?? usage.completion_tokens;
      usage.total_tokens = json.usage.total_tokens ?? usage.total_tokens;
      usage.cost = json.usage.cost ?? usage.cost;
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      handlers.onToken?.(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolAcc[idx]) {
          toolAcc[idx] = { id: tc.id || `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
        }
        const acc = toolAcc[idx];
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        if (acc.function.name && !announced.has(idx)) {
          announced.add(idx);
          handlers.onToolStart?.(acc.function.name);
        }
      }
    }
  };

  // read SSE stream
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete tail
    for (const line of lines) flushLine(line);
  }
  if (buffer) flushLine(buffer);

  const toolCalls = Object.keys(toolAcc)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => toolAcc[Number(k)])
    .filter((t) => t.function.name);

  return { content, toolCalls, finishReason, usage };
}
