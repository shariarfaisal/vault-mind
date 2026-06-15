# Research Agent — Design Spec

**Date:** 2026-06-15
**Component:** Vault Mind (Obsidian plugin)
**Status:** Approved design, pending implementation plan

## Goal

Add a focused **research** capability to the Vault Mind agent: given an open-ended question, it plans, searches the internet AND the user's vault, curates findings without losing focus, and writes a structured, cited report note. Solves the failure mode where the general agent loop drifts off-task on multi-step research.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Architecture | Dedicated research **sub-loop**, isolated from the main agent loop |
| Sources | **Web + vault** (cites URLs and `[[vault notes]]`) |
| Output | **Cited report note** in `Research/` folder |
| Trigger | **Tool + explicit**: `deep_research` tool the main agent auto-calls, plus a starter chip / phrasing |
| Model | **Separate `researchModel` setting**, falls back to the main chat model |

## Architecture

New module **`agent/research.ts`** exporting:

```
runResearch(query, settings, toolCtx, events, signal): Promise<ResearchResult>
```

The main agent loop delegates the entire research task to this contained sub-loop and receives back a single result (report path + summary). Isolation from the main loop is the primary mechanism preventing focus loss — the sub-loop has its own state, its own prompts, and its own budget.

A `deep_research` tool in `agent/tools.ts` is the bridge: its handler calls `runResearch` and returns the report path + summary as the tool result.

## Focus mechanism (core)

The sub-loop threads an explicit **research state** object through every iteration:

```
ResearchState {
  goal: string              // frozen original question — re-injected every step, never mutated
  plan: string[]            // 3-6 sub-questions, generated once during the Plan phase
  findings: Finding[]       // curated evidence
  openQuestions: string[]   // sub-questions not yet answered
}

Finding {
  claim: string
  source: string            // URL or vault note path
  sourceType: 'url' | 'note'
  snippet: string           // supporting excerpt
}
```

Each iteration's prompt is built from: `goal` + `plan` + `findings so far` + the next unanswered sub-question. The model's allowed actions per step are constrained to: search the web, search the vault, fetch/read a source, `record_finding`, or mark a sub-question answered. Because the frozen goal and plan are re-injected every step, the model cannot wander onto unrelated tangents.

## Data flow

1. **Plan** — the research model drafts 3-6 sub-questions from the goal → populates `plan` and `openQuestions`.
2. **Gather** (bounded by `maxResearchSteps`, default 15) — for each open sub-question: run `web_search` + `search_vault`, fetch the top hits (`fetch_url` / `read_note`), extract and curate findings into state. Dedup findings by source+claim; always keep the source reference.
3. **Synthesize** — the research model writes the report from `findings` ONLY (strictly grounded). Every claim is cited `[N]`, where `[N]` resolves to a web URL or a `[[vault note]]`. Includes an executive summary, structured sections, and a Sources list.
4. **Write** — save the report to `Research/<slug>.md` via the existing note-creation path; register it on the undo stack.
5. **Return** — hand back a summary + `[[wikilink]]` to the main agent, which surfaces it in chat.

## Tool surface + trigger

- **`deep_research(query, depth?)`** tool — registered in `TOOL_SCHEMAS`; handler invokes `runResearch`. `depth` optionally scales `maxResearchSteps` for this call.
- Internally reuses existing tools/retrieval: `web_search`, `fetch_url`, `search_vault`, `read_note`, `create_note`. No duplicate implementations.
- **Auto trigger:** a system-prompt rule instructing the agent to call `deep_research` for open-ended / multi-source research questions (rather than answering shallowly inline).
- **Explicit trigger:** a starter chip — *"Research a topic and write me a cited report."* — and natural phrasing like "research X for me."

## Settings (exposed in UI)

| Setting | Type | Default | Notes |
|---------|------|---------|-------|
| `researchModel` | string (model picker) | `""` → falls back to `model` | Research is deeper/longer; allows a stronger model than everyday chat |
| `maxResearchSteps` | slider | 15 | Gather-phase iteration budget |
| `researchFolder` | string | `Research` | Where report notes are written |

Model picker reuses the existing OpenRouter model-list popup component (consistent with the main model selector).

## UI / trace

The sub-loop emits the existing `AgentEvents` so the chat trace renders nested steps: **Plan** → per-sub-question **search/fetch** cards → **Synthesize** → **report link**. Token and cost usage from the sub-loop folds into the turn's usage readout. Add icon + friendly label + result-summary mappings in `ui/AgentView.ts` for `deep_research` and `record_finding`.

## Error handling

- **Web search fails / no results** → record the gap, continue other sub-questions, and flag the point as "unverified" in the report. Never fabricate.
- **Step budget hit** → stop gathering and synthesize from whatever was collected (mirrors the main loop's cap behavior).
- **Sub-loop throws** → return a partial report (if any findings exist) plus the error to the main agent; surface as a normal tool error otherwise.
- **Abort signal** → honored at every iteration boundary, same as the main loop.

## Testing

- **Happy path (manual):** "Research the current state of X" → verify a plan is produced, findings come from BOTH web and vault, a cited report note is created in `Research/`, and all `[[links]]` / `[N]` citations resolve.
- **Offline / web down:** research proceeds with vault-only sources and explicitly notes web gaps.
- **Empty vault:** falls back to web-only sources, still produces a report.
- **Budget edge:** set `maxResearchSteps` low → confirm graceful synthesis from partial findings.

## Scope guard (YAGNI — explicitly out)

- No parallel sub-agents / fan-out (single contained loop).
- No new vector store or embeddings work (reuse existing hybrid retriever).
- No scheduled or recurring research runs.
- No companion structured-data file (report note only; can revisit later).
