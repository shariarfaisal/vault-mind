# Vault Mind

An agentic AI assistant embedded in your [Obsidian](https://obsidian.md) vault. It plans, searches, traverses links, reads your notes, and answers with citations — grounded in your actual knowledge graph, not the model's guesses. Powered exclusively by [OpenRouter](https://openrouter.ai) (300+ models, $10 credit → 1000 free requests across all providers — no separate API keys needed).

> Desktop only. All your notes stay local — only model API calls leave your machine.

## Demo

![Vault Mind agent answering a question with citations and tool traces](docs/demo.png)

*The agent searches your vault, reads notes, and returns grounded answers with `[1]` citations and expandable tool traces showing every step.*

## Features

- **Grounded answers** — searches your vault, follows `[[links]]` and backlinks, cites every claim with a clickable `[[wikilink]]`
- **Agentic loop** — plan-then-execute reasoning over your notes, with optional planner phase
- **Hybrid retrieval** — keyword (MiniSearch / BM25) + optional local semantic search via on-device embeddings (`@xenova/transformers`, ONNX) — no data leaves your machine for retrieval
- **Vault mutations** — create, update, move, delete notes and canvases (destructive actions confirmed by you), with one-click undo
- **Skills** — reusable instruction recipes the agent can follow
- **Web browsing** — search the internet and read pages for external context
- **GitHub connector** — read repos/issues/commits, import issues into your vault as notes
- **Kanban integration** — add cards to boards if the Kanban plugin is installed
- **Long-term memory** — remembers durable facts, decisions, and preferences across sessions
- **Token + cost tracking** — real API consumption per message and per session

## Install (manual)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/vault-mind/`.
3. Reload Obsidian → Settings → Community Plugins → enable **Vault Mind**.

## Setup

Vault Mind uses **only OpenRouter** — no separate OpenAI, Anthropic, or Google API keys needed.

1. Create a free account at [openrouter.ai](https://openrouter.ai) and get an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Add $10 credit — this unlocks **1000 free requests per provider** (OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek, and 300+ more). Each provider resets its free tier independently.
3. Open **Vault Mind** settings → paste your key.
4. Pick a model. Tool-capable models are sorted first in the picker.
5. (Optional) Add a GitHub token to enable the GitHub connector.

Your key and settings are stored locally in `data.json` inside the plugin folder. **They are never committed** (see `.gitignore`).

## Build from source

```bash
git clone <this-repo>
cd vault-mind
npm install
npm run build      # type-check + production bundle -> main.js
# or: npm run dev   # watch mode
```

Then copy `main.js`, `manifest.json`, `styles.css` into your vault's plugin folder (or symlink the repo there during development).

## Tech stack

TypeScript · esbuild · Obsidian Plugin API · OpenRouter (SSE streaming + tool-calling) · MiniSearch · `@xenova/transformers` (local embeddings) · graph traversal via Obsidian `resolvedLinks`. No external server.

## Contributing

PRs welcome. Copy `data.json.example` → `data.json` is **not** needed — Obsidian generates `data.json` on first run. Never commit `data.json` (it holds your API key and chat history).

## License

[MIT](LICENSE) © Hasan Mehdi
