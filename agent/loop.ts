// Agentic ReAct loop: LLM -> tool calls -> execute against vault -> feed back -> repeat.
// This loop is what makes Vault Mind an agent, not a chatbot (PRD §4.1).

import { ChatMessage, VaultMindSettings, Usage } from "../types";
import { streamCompletion } from "../llm/openrouter";
import { TOOL_SCHEMAS, runTool, ToolContext } from "./tools";

export interface AgentEvents {
  onThinkingToken?: (t: string) => void; // streamed assistant text (interim or final)
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
  onIteration?: (i: number, max: number) => void;
  onCompress?: (freedChars: number) => void;
  onUsage?: (turn: Usage) => void; // cumulative usage for this turn
  onFinal?: (text: string) => void;
  onError?: (msg: string) => void;
}

function addUsage(acc: Usage, u?: Usage) {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens || 0;
  acc.completion_tokens += u.completion_tokens || 0;
  acc.total_tokens += u.total_tokens || 0;
  acc.cost += u.cost || 0;
}

function transcriptSize(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.content?.length || 0), 0);
}

// Sawtooth context compression (PRD §4.4): when the transcript grows past budget,
// summarize the middle of the conversation into a persistent Knowledge block and
// drop the raw messages it replaces. Keeps system prompt + original task + recent tail.
async function compressContext(
  messages: ChatMessage[],
  settings: VaultMindSettings,
  signal: AbortSignal,
  turnUsage: Usage
): Promise<number> {
  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser < 0) return 0;
  const headEnd = firstUser + 1; // keep system..first user (the task)
  const keepTail = 3;
  const tailStart = messages.length - keepTail;
  if (tailStart - headEnd < 3) return 0; // not enough middle to bother

  const middle = messages.slice(headEnd, tailStart);
  // never compress an assistant turn that has unanswered tool_calls at the boundary
  const before = transcriptSize(messages);

  const summarizePrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        "You compress an agent's working memory. Summarize the evidence gathered so far into a compact 'Knowledge so far' block: bullet points of key facts, each tagged with its source note path and any [N] citation index already used. Preserve anything needed to answer the user. Be terse. Output only the summary.",
    },
    {
      role: "user",
      content: middle.map((m) => `[${m.role}${m.name ? ":" + m.name : ""}] ${m.content || ""}`).join("\n\n").slice(0, 24000),
    },
  ];

  let summary = "";
  try {
    const res = await streamCompletion({ apiKey: settings.apiKey, model: settings.model, messages: summarizePrompt, temperature: 0, signal });
    summary = res.content;
    addUsage(turnUsage, res.usage);
  } catch {
    return 0; // compression best-effort; skip on failure
  }
  if (!summary) return 0;

  const knowledge: ChatMessage = { role: "system", content: `[Compressed context — Knowledge so far]\n${summary}` };
  messages.splice(headEnd, middle.length, knowledge);
  return Math.max(0, before - transcriptSize(messages));
}

export const SYSTEM_PROMPT = `You are Vault Mind, an agent living inside the user's Obsidian knowledge vault.

You think and act in a loop. To answer, you FIRST gather evidence using your tools, then reason over it.

Rules:
- ALWAYS ground answers in the user's actual notes. Use search_vault to find relevant notes, then read_note / traverse_links to follow the graph and gather connected context.
- Prefer following links/backlinks to surface NON-OBVIOUS connections across different notes and domains. The value is in the connections, not single notes.
- Cite every claim with the [N] index returned by search_vault, AND name the source note as a [[wikilink]] so the user can click through.
- If the notes do not contain the answer, say so plainly. Never invent facts.
- Be concise. Gather only the context you need (minimal context, maximum useful output).
- When you have enough evidence, STOP calling tools and write the final grounded answer.
- If the request is ambiguous or you must choose between options, use ask_user with suggested options instead of guessing. Wait for the answer, then continue.

You can also ACT on the vault when asked: create_note, update_note, delete_file, create_folder, move_file, and create_canvas. Pick sensible paths. Destructive actions are confirmed by the user. When you create or change a file, mention it as a [[wikilink]] so the user can open it.

You have SKILLS — reusable instruction recipes. If the user asks for something a skill covers, call list_skills then use_skill to follow its procedure.

You can BROWSE the internet: web_search to find pages, fetch_url to read one. Use it for current/external info not in the vault, and cite the URL.

You know this vault's PLUGINS: list_plugins and plugin_info tell you what's installed. If the user has the Kanban plugin and a board, use add_kanban_card to add cards to a column.

You connect to GITHUB: github_repo, github_issues, github_issue, github_commits to read, and github_import_issues to pull issues into the vault as notes (the substrate that external tools write into).

You have long-term MEMORY: use remember to save durable facts/decisions/preferences, and recall to retrieve them. Relevant memories are auto-injected. Remember important things the user tells you.`;

// `messages` is the running conversation (system + prior turns + new user message).
// The loop mutates it in place so multi-turn chat history is preserved by the caller.
export async function runAgent(
  messages: ChatMessage[],
  settings: VaultMindSettings,
  toolCtx: ToolContext,
  events: AgentEvents,
  signal: AbortSignal
): Promise<void> {
  const max = settings.maxIterations || 8;
  const turnUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };

  // Plan-then-execute: draft a short plan before acting (optional, more reliable).
  if (settings.usePlanner) {
    try {
      const plan = await streamCompletion(
        {
          apiKey: settings.apiKey,
          model: settings.model,
          messages: [...messages, { role: "user", content: "Before acting, write a brief numbered plan (max 5 steps) of how you'll answer, naming the tools you'll use. Plan only — do not execute yet." }],
          temperature: 0,
          signal,
        },
        {}
      );
      addUsage(turnUsage, plan.usage);
      if (plan.content?.trim()) messages.push({ role: "system", content: `[Plan]\n${plan.content.trim()}` });
    } catch {
      /* planning is best-effort */
    }
  }

  for (let i = 0; i < max; i++) {
    events.onIteration?.(i + 1, max);
    if (signal.aborted) return;

    let result;
    try {
      result = await streamCompletion(
        {
          apiKey: settings.apiKey,
          model: settings.model,
          messages,
          tools: TOOL_SCHEMAS,
          temperature: settings.temperature,
          signal,
        },
        {
          onToken: (t) => events.onThinkingToken?.(t),
          onToolStart: () => {},
        }
      );
    } catch (e: any) {
      if (signal.aborted) return;
      events.onError?.(e?.message || String(e));
      return;
    }

    addUsage(turnUsage, result.usage);

    // Record the assistant turn.
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
    };
    messages.push(assistantMsg);

    // No tool calls => this is the final answer.
    if (!result.toolCalls.length) {
      let answer = (typeof result.content === "string" ? result.content : "").trim();
      // Weak models sometimes finish with empty content after a tool call — force a synthesis.
      if (!answer) {
        try {
          const f = await streamCompletion(
            {
              apiKey: settings.apiKey,
              model: settings.model,
              messages: [...messages, { role: "user", content: "Answer the original question now using the information gathered. Be concise and cite [[notes]]." }],
              temperature: settings.temperature,
              signal,
            },
            { onToken: (t) => events.onThinkingToken?.(t) }
          );
          addUsage(turnUsage, f.usage);
          answer = (f.content || "").trim();
        } catch (e: any) {
          if (signal.aborted) return;
        }
      }
      events.onUsage?.(turnUsage);
      events.onFinal?.(answer || "The model returned an empty response. Try again or switch to a stronger model (free models are often rate-limited or terse).");
      return;
    }

    // Execute each requested tool and feed results back.
    for (const tc of result.toolCalls) {
      if (signal.aborted) return;
      events.onToolCall?.(tc.function.name, tc.function.arguments);
      let toolResult: string;
      try {
        toolResult = await runTool(toolCtx, tc.function.name, tc.function.arguments);
      } catch (e: any) {
        toolResult = `Error running ${tc.function.name}: ${e?.message || e}`;
      }
      events.onToolResult?.(tc.function.name, toolResult);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: toolResult,
      });
    }

    // Sawtooth compression: if the transcript outgrew its budget, consolidate.
    if (settings.compressContext && transcriptSize(messages) > settings.contextBudgetChars) {
      const freed = await compressContext(messages, settings, signal, turnUsage);
      if (freed > 0) events.onCompress?.(freed);
    }
  }

  // Hit iteration cap — ask for a final synthesis without tools.
  if (signal.aborted) return;
  try {
    const finalRes = await streamCompletion(
      {
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [
          ...messages,
          { role: "user", content: "Stop gathering. Give your best grounded, cited answer now using only what you've collected." },
        ],
        temperature: settings.temperature,
        signal,
      },
      { onToken: (t) => events.onThinkingToken?.(t) }
    );
    addUsage(turnUsage, finalRes.usage);
    events.onUsage?.(turnUsage);
    events.onFinal?.(finalRes.content || "(no answer)");
  } catch (e: any) {
    if (!signal.aborted) events.onError?.(e?.message || String(e));
  }
}
