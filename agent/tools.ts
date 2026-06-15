// Vault operations exposed as agent tools (OpenRouter function-calling schemas + handlers).
// Read tools + full CRUD (files, folders, canvas) + skills.

import { App, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import { ToolSchema, RetrievedChunk, VaultMindSettings, Usage } from "../types";
import { Retriever } from "./retriever";
import { SkillManager } from "./skills";
import { runResearch } from "./research";
import * as gh from "./github";

export interface ToolContext {
  app: App;
  retriever: Retriever;
  settings: VaultMindSettings;
  citations: RetrievedChunk[];
  skills: SkillManager;
  // ask user to confirm a destructive/mutating action; resolves true if approved
  confirm: (title: string, detail: string) => Promise<boolean>;
  // ask the user a clarifying question (options selectable or free text); resolves with answer
  askUser: (question: string, options: string[], multiple: boolean) => Promise<string>;
  // notify host that a file was created/modified (so it can open it)
  onFileTouched?: (path: string) => void;
  // long-term memory store
  remember: (text: string) => void;
  recall: (query: string) => string;
  // record an inverse op so the user can undo a mutation
  pushUndo: (entry: UndoEntry) => void;
  // token/cost usage from nested LLM calls (e.g. the deep_research sub-loop)
  onUsage?: (u: Usage) => void;
  // progress line from a long-running tool (e.g. deep_research phases)
  onResearchStep?: (label: string) => void;
  // abort signal for long-running tools (e.g. deep_research) so Stop halts them
  signal?: AbortSignal;
}

export interface UndoEntry {
  op: "create" | "modify" | "delete" | "move";
  path?: string; // for create/modify/delete
  before?: string | null; // prior content (null = file didn't exist)
  from?: string; // for move
  to?: string;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  // ---- read / search ----
  {
    type: "function",
    function: {
      name: "search_vault",
      description:
        "Search the whole vault for notes relevant to a query (hybrid keyword + semantic + graph). Use first to find which notes matter. Returns ranked chunks with a [N] citation index, note path and heading.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          k: { type: "integer", description: "Max results (default 6)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full markdown body of a note by its vault path.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "traverse_links",
      description: "Get graph neighbors of a note: outgoing links, backlinks, or both.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, direction: { type: "string", enum: ["outgoing", "backlinks", "both"] } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_note",
      description: "Get the note the user is currently viewing, plus its immediate link neighbors.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List notes in the vault, optionally filtered by folder prefix or tag.",
      parameters: {
        type: "object",
        properties: { folder: { type: "string" }, tag: { type: "string" }, limit: { type: "integer" } },
      },
    },
  },
  // ---- write / CRUD ----
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new markdown note at a vault path (folders auto-created). Use for saving generated content. Confirms if overwriting.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault path, e.g. Projects/Plan.md" },
          content: { type: "string", description: "Markdown content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Update an existing note. mode: overwrite (replace all), append (add to end), or prepend (add to start).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append", "prepend"] },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a note, canvas, or other file (moved to system trash). Destructive — always confirmed.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Create a folder at a vault path.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename a file/note. Updates links automatically. Confirmed.",
      parameters: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_canvas",
      description: "Create an Obsidian canvas (.canvas). Pass file paths to embed as cards and/or text nodes; they are laid out in a grid.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Canvas path, e.g. Maps/Overview.canvas" },
          files: { type: "array", items: { type: "string" }, description: "Note paths to embed as cards" },
          texts: { type: "array", items: { type: "string" }, description: "Text nodes" },
        },
        required: ["path"],
      },
    },
  },
  // ---- internet ----
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web. Returns titles, URLs and snippets. Use to find current information not in the vault.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, count: { type: "integer", description: "Max results (default 6)" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page and return its readable text content. Use after web_search to read a result.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Call any third-party HTTP/REST API and return the raw response (JSON or text). Use for authenticated or non-HTML data sources (e.g. public APIs, services with a token). Supply auth via the headers argument. Prefer fetch_url for reading human web pages; use this for structured/API data.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full request URL, including query string." },
          method: { type: "string", description: "HTTP method (GET, POST, PUT, PATCH, DELETE). Default GET." },
          headers: { type: "object", description: "Request headers as a JSON object, e.g. { \"Authorization\": \"Bearer ...\", \"Content-Type\": \"application/json\" }." },
          body: { type: "string", description: "Request body for POST/PUT/PATCH. For JSON, pass a JSON string and set Content-Type: application/json." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_research",
      description:
        "Run a focused multi-step research task and write a structured, cited report note. Use for open-ended or multi-source questions that need real investigation across the web AND the user's vault (not a single lookup). It plans sub-questions, gathers and curates evidence without drifting, then writes a Research/ report note with citations. Returns the report path and a summary.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The research question or topic." },
          depth: { type: "integer", description: "Optional gather-step budget override (default from settings)." },
        },
        required: ["query"],
      },
    },
  },
  // ---- plugins ----
  {
    type: "function",
    function: {
      name: "list_plugins",
      description: "List the community plugins installed in this vault (id, name, enabled, description).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "plugin_info",
      description: "Get details about an installed plugin by id or name (version, author, description, folder).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_kanban_card",
      description: "Add a card to a Kanban board note (obsidian-kanban). Provide the board path, the list/column name, and the card text.",
      parameters: {
        type: "object",
        properties: {
          board: { type: "string", description: "Path to the kanban .md board" },
          list: { type: "string", description: "Column/list heading to add under" },
          card: { type: "string", description: "Card text" },
        },
        required: ["board", "list", "card"],
      },
    },
  },
  // ---- github ----
  {
    type: "function",
    function: {
      name: "github_repo",
      description: "Get metadata for the configured GitHub repo (or pass repo as owner/name).",
      parameters: { type: "object", properties: { repo: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "github_issues",
      description: "List GitHub issues. state: open|closed|all.",
      parameters: {
        type: "object",
        properties: { repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] }, limit: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_issue",
      description: "Get one GitHub issue by number (full body).",
      parameters: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" } }, required: ["number"] },
    },
  },
  {
    type: "function",
    function: {
      name: "github_commits",
      description: "List recent commits for the repo.",
      parameters: { type: "object", properties: { repo: { type: "string" }, limit: { type: "integer" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "github_import_issues",
      description: "Import GitHub issues into vault notes (one note per issue, with frontmatter and links). Use to bring external work into the knowledge substrate.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          folder: { type: "string", description: "Target folder (default GitHub/<repo>)" },
          limit: { type: "integer" },
        },
      },
    },
  },
  // ---- memory ----
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a durable fact/decision/preference to long-term memory so it persists across chats. Use for things worth recalling later.",
      parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Search long-term memory for facts relevant to a query.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  // ---- interaction ----
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a clarifying question when you need more information or a decision before proceeding. Provide options they can pick from; they may also type a free answer. Use this instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, description: "Suggested choices (optional)" },
          allow_multiple: { type: "boolean", description: "Allow selecting more than one option" },
        },
        required: ["question"],
      },
    },
  },
  // ---- skills ----
  {
    type: "function",
    function: {
      name: "list_skills",
      description: "List the user's saved skills (reusable instruction recipes) with their descriptions.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "use_skill",
      description: "Load a skill by name and follow its instructions. Returns the skill's procedure to execute.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, input: { type: "string", description: "Optional input/context for the skill" } },
        required: ["name"],
      },
    },
  },
];

// ---------- helpers ----------
function resolveFile(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(normalizePath(path));
  if (f instanceof TFile) return f;
  const match = app.vault.getMarkdownFiles().find((mf) => mf.path === path || mf.basename === path.replace(/\.md$/, ""));
  return match || null;
}
function backlinksOf(app: App, target: TFile): string[] {
  const resolved = app.metadataCache.resolvedLinks;
  const out: string[] = [];
  for (const src in resolved) if (resolved[src][target.path]) out.push(src);
  return out;
}
function outgoingOf(app: App, file: TFile): string[] {
  return Object.keys(app.metadataCache.resolvedLinks[file.path] || {});
}
async function ensureParent(app: App, path: string) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
}

export async function runTool(ctx: ToolContext, name: string, argsJson: string): Promise<string> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return `Error: arguments were not valid JSON: ${argsJson}`;
  }
  const { app } = ctx;
  const mutating = ["create_note", "update_note", "delete_file", "create_folder", "move_file", "create_canvas", "add_kanban_card"];
  if (mutating.includes(name) && !ctx.settings.enableWrites) {
    return "Writes are disabled. Enable 'Allow note writing' in Vault Mind settings.";
  }

  switch (name) {
    case "search_vault": {
      ctx.retriever.configure(ctx.settings.useSemantic, ctx.settings.embedModel);
      if (!ctx.retriever.isBuilt()) await ctx.retriever.build();
      const k = args.k || ctx.settings.topK || 6;
      const hits = await ctx.retriever.search(String(args.query || ""), k);
      if (!hits.length) return "No matching notes found.";
      return hits.map((h) => `[${registerCitation(ctx, h)}] ${h.path} › ${h.heading}\n${h.text}`).join("\n\n---\n");
    }
    case "read_note": {
      const f = resolveFile(app, String(args.path || ""));
      if (!f) return `Error: note not found: ${args.path}`;
      return `# ${f.path}\n\n${(await app.vault.cachedRead(f)).slice(0, 6000)}`;
    }
    case "traverse_links": {
      const f = resolveFile(app, String(args.path || ""));
      if (!f) return `Error: note not found: ${args.path}`;
      const dir = args.direction || "both";
      const out: string[] = [];
      if (dir !== "backlinks") out.push(`Outgoing: ${outgoingOf(app, f).join(", ") || "(none)"}`);
      if (dir !== "outgoing") out.push(`Backlinks: ${backlinksOf(app, f).join(", ") || "(none)"}`);
      return out.join("\n");
    }
    case "get_active_note": {
      const f = app.workspace.getActiveFile();
      if (!f) return "No note is currently active.";
      const body = await app.vault.cachedRead(f);
      const nbr = [...new Set([...outgoingOf(app, f), ...backlinksOf(app, f)])];
      return `Active note: ${f.path}\nNeighbors: ${nbr.join(", ") || "(none)"}\n\n${body.slice(0, 4000)}`;
    }
    case "list_notes": {
      let files = app.vault.getMarkdownFiles();
      if (args.folder) files = files.filter((f) => f.path.startsWith(args.folder));
      if (args.tag) {
        files = files.filter((f) => {
          const cache = app.metadataCache.getFileCache(f);
          const tags = (cache?.tags || []).map((t) => t.tag.replace(/^#/, ""));
          const fmTags = ([] as string[]).concat((cache?.frontmatter?.tags as any) || []);
          return tags.includes(args.tag) || fmTags.includes(args.tag);
        });
      }
      return files.slice(0, args.limit || 50).map((f) => f.path).join("\n") || "(no notes)";
    }

    case "create_note": {
      const path = normalizePath(String(args.path || ""));
      if (!path) return "Error: path required.";
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) {
        if (!(await ctx.confirm("Overwrite note?", path))) return "User declined the overwrite.";
        if (existing instanceof TFile) {
          ctx.pushUndo({ op: "modify", path, before: await app.vault.read(existing) });
          await app.vault.modify(existing, String(args.content || ""));
        }
      } else {
        await ensureParent(app, path);
        await app.vault.create(path, String(args.content || ""));
        ctx.pushUndo({ op: "create", path, before: null });
      }
      ctx.onFileTouched?.(path);
      return `Created note: ${path}`;
    }
    case "update_note": {
      const f = resolveFile(app, String(args.path || ""));
      if (!f) return `Error: note not found: ${args.path}`;
      const mode = args.mode || "append";
      const content = String(args.content || "");
      if (mode === "overwrite" && !(await ctx.confirm("Overwrite note?", f.path))) return "User declined.";
      const prev = await app.vault.read(f);
      const next = mode === "overwrite" ? content : mode === "prepend" ? content + "\n\n" + prev : prev + "\n\n" + content;
      ctx.pushUndo({ op: "modify", path: f.path, before: prev });
      await app.vault.modify(f, next);
      ctx.onFileTouched?.(f.path);
      return `Updated note (${mode}): ${f.path}`;
    }
    case "delete_file": {
      const path = normalizePath(String(args.path || ""));
      const f = app.vault.getAbstractFileByPath(path);
      if (!f) return `Error: file not found: ${path}`;
      if (!(await ctx.confirm("Delete file?", path))) return "User declined the deletion.";
      if (f instanceof TFile) ctx.pushUndo({ op: "delete", path, before: await app.vault.read(f) });
      await app.vault.trash(f, true);
      return `Deleted: ${path}`;
    }
    case "create_folder": {
      const path = normalizePath(String(args.path || ""));
      if (app.vault.getAbstractFileByPath(path)) return `Folder already exists: ${path}`;
      await app.vault.createFolder(path);
      return `Created folder: ${path}`;
    }
    case "move_file": {
      const from = normalizePath(String(args.from || ""));
      const to = normalizePath(String(args.to || ""));
      const f = app.vault.getAbstractFileByPath(from);
      if (!f) return `Error: file not found: ${from}`;
      if (!(await ctx.confirm("Move / rename?", `${from}  →  ${to}`))) return "User declined the move.";
      await ensureParent(app, to);
      await app.fileManager.renameFile(f, to);
      ctx.pushUndo({ op: "move", from, to });
      ctx.onFileTouched?.(to);
      return `Moved: ${from} → ${to}`;
    }
    case "create_canvas": {
      let path = normalizePath(String(args.path || ""));
      if (!path.endsWith(".canvas")) path += ".canvas";
      const canvas = buildCanvas(args.files || [], args.texts || []);
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) {
        if (!(await ctx.confirm("Overwrite canvas?", path))) return "User declined.";
        if (existing instanceof TFile) {
          ctx.pushUndo({ op: "modify", path, before: await app.vault.read(existing) });
          await app.vault.modify(existing, canvas);
        }
      } else {
        await ensureParent(app, path);
        await app.vault.create(path, canvas);
        ctx.pushUndo({ op: "create", path, before: null });
      }
      ctx.onFileTouched?.(path);
      return `Created canvas: ${path}`;
    }

    case "web_search": {
      try {
        const q = encodeURIComponent(String(args.query || ""));
        const res = await requestUrl({ url: `https://html.duckduckgo.com/html/?q=${q}`, headers: { "User-Agent": "Mozilla/5.0" } });
        const results = parseDuckDuckGo(res.text, args.count || 6);
        if (!results.length) return "No web results.";
        return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
      } catch (e: any) {
        return `Error searching web: ${e?.message || e}`;
      }
    }
    case "fetch_url": {
      try {
        const res = await requestUrl({ url: String(args.url || ""), headers: { "User-Agent": "Mozilla/5.0" } });
        return `URL: ${args.url}\n\n${htmlToText(res.text).slice(0, 8000)}`;
      } catch (e: any) {
        return `Error fetching URL: ${e?.message || e}`;
      }
    }
    case "http_request": {
      const url = String(args.url || "");
      if (!url) return "Error: http_request requires a url.";
      const method = String(args.method || "GET").toUpperCase();
      // headers may arrive as an object or a JSON string depending on the model.
      let headers: Record<string, string> = {};
      try {
        const h = typeof args.headers === "string" ? JSON.parse(args.headers) : args.headers;
        if (h && typeof h === "object") for (const k of Object.keys(h)) headers[k] = String(h[k]);
      } catch {
        return "Error: headers must be a JSON object.";
      }
      const body = args.body != null ? String(args.body) : undefined;
      try {
        // requestUrl bypasses CORS and supports any method/headers/body.
        const res = await requestUrl({ url, method, headers, body, throw: false });
        const text = res.text || "";
        const trimmed = text.length > 12000 ? text.slice(0, 12000) + `\n…[truncated, ${text.length} chars total]` : text;
        return `${method} ${url} → ${res.status}\n\n${trimmed}`;
      } catch (e: any) {
        return `Error calling ${url}: ${e?.message || e}`;
      }
    }
    case "deep_research": {
      const query = String(args.query || "").trim();
      if (!query) return "Error: deep_research requires a query.";
      const depth = typeof args.depth === "number" ? args.depth : undefined;
      return await runResearch(ctx, query, depth);
    }
    case "list_plugins": {
      const plugins = (app as any).plugins;
      const manifests = plugins?.manifests || {};
      const enabled: Set<string> = plugins?.enabledPlugins || new Set();
      const rows = Object.values(manifests).map((m: any) => `- ${m.name} (${m.id})${enabled.has(m.id) ? " [enabled]" : " [disabled]"}: ${m.description || ""}`);
      return rows.length ? rows.join("\n") : "No community plugins installed.";
    }
    case "plugin_info": {
      const plugins = (app as any).plugins;
      const manifests = plugins?.manifests || {};
      const key = String(args.id || "");
      const m: any = manifests[key] || Object.values(manifests).find((x: any) => x.name.toLowerCase() === key.toLowerCase());
      if (!m) return `Plugin not found: ${args.id}`;
      const enabled = (plugins?.enabledPlugins as Set<string>)?.has(m.id);
      return `Name: ${m.name}\nId: ${m.id}\nVersion: ${m.version}\nAuthor: ${m.author || "?"}\nEnabled: ${enabled}\nDescription: ${m.description || ""}`;
    }
    case "add_kanban_card": {
      const f = resolveFile(app, String(args.board || ""));
      if (!f) return `Error: board not found: ${args.board}`;
      const body = await app.vault.read(f);
      const updated = insertKanbanCard(body, String(args.list || ""), String(args.card || ""));
      if (!updated) return `Error: list "${args.list}" not found in board. Available: ${kanbanLists(body).join(", ") || "(none)"}`;
      await app.vault.modify(f, updated);
      ctx.onFileTouched?.(f.path);
      return `Added card to "${args.list}" in ${f.path}`;
    }

    case "github_repo":
    case "github_issues":
    case "github_issue":
    case "github_commits":
    case "github_import_issues": {
      const repo = String(args.repo || ctx.settings.githubRepo || "");
      if (!repo) return "No GitHub repo configured. Set it in Vault Mind settings or pass repo=owner/name.";
      const token = ctx.settings.githubToken;
      try {
        if (name === "github_repo") return await gh.repoInfo(repo, token);
        if (name === "github_issues") return await gh.listIssues(repo, token, args.state || "open", args.limit || 15);
        if (name === "github_issue") return await gh.getIssue(repo, token, Number(args.number));
        if (name === "github_commits") return await gh.listCommits(repo, token, args.limit || 15);
        // import issues → notes
        if (!ctx.settings.enableWrites) return "Enable vault editing to import issues.";
        const issues = await gh.fetchIssuesForImport(repo, token, args.state || "open", args.limit || 20);
        if (!issues.length) return "No issues to import.";
        const folder = normalizePath(args.folder || `GitHub/${repo.replace("/", "-")}`);
        if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder).catch(() => {});
        let count = 0;
        for (const i of issues) {
          const safe = `${i.number} - ${i.title}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
          const path = `${folder}/${safe}.md`;
          const fm = `---\ntype: github-issue\nrepo: ${repo}\nnumber: ${i.number}\nstate: ${i.state}\nauthor: ${i.user}\nlabels: [${i.labels.join(", ")}]\nurl: ${i.url}\n---\n`;
          const body = `# ${i.title}\n\n${i.body || "(no body)"}\n`;
          const existing = app.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) await app.vault.modify(existing, fm + body);
          else await app.vault.create(path, fm + body);
          count++;
        }
        ctx.onFileTouched?.(folder);
        return `Imported ${count} issues into ${folder}`;
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
    }
    case "remember": {
      ctx.remember(String(args.fact || ""));
      return `Remembered: ${args.fact}`;
    }
    case "recall": {
      return ctx.recall(String(args.query || ""));
    }
    case "ask_user": {
      const opts = Array.isArray(args.options) ? args.options.map(String) : [];
      const ans = await ctx.askUser(String(args.question || ""), opts, !!args.allow_multiple);
      return ans ? `User answered: ${ans}` : "User dismissed the question without answering.";
    }
    case "list_skills": {
      const skills = ctx.skills.list();
      if (!skills.length) return "No skills defined. Create notes in the skills folder with name/description frontmatter.";
      return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    }
    case "use_skill": {
      const skill = await ctx.skills.get(String(args.name || ""));
      if (!skill) return `Error: skill not found: ${args.name}. Use list_skills to see available skills.`;
      return `SKILL: ${skill.name}\n${skill.description}\n\n--- Instructions (follow these now) ---\n${skill.body}${args.input ? `\n\n--- Input ---\n${args.input}` : ""}`;
    }
    default:
      return `Error: unknown tool ${name}`;
  }
}

function buildCanvas(files: string[], texts: string[]): string {
  const nodes: any[] = [];
  const W = 320, H = 220, GAP = 60, COLS = 3;
  let i = 0;
  const place = () => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const pos = { x: col * (W + GAP), y: row * (H + GAP), width: W, height: H };
    i++;
    return pos;
  };
  for (const f of files) nodes.push({ id: `f${i}`, type: "file", file: normalizePath(f), ...place() });
  for (const t of texts) nodes.push({ id: `t${i}`, type: "text", text: t, ...place() });
  return JSON.stringify({ nodes, edges: [] }, null, 2);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function parseDuckDuckGo(html: string, count: number): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm;
  while ((sm = snipRe.exec(html))) snippets.push(htmlToText(sm[1]));
  let m;
  let i = 0;
  while ((m = re.exec(html)) && out.length < count) {
    let url = m[1];
    const dec = url.match(/uddg=([^&]+)/);
    if (dec) url = decodeURIComponent(dec[1]);
    out.push({ title: htmlToText(m[2]), url, snippet: snippets[i] || "" });
    i++;
  }
  return out;
}

function kanbanLists(body: string): string[] {
  return [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
}

// Insert a "- [ ] card" under the matching "## list" heading (before the next ## or end).
function insertKanbanCard(body: string, list: string, card: string): string | null {
  const lines = body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m && m[1].trim().toLowerCase() === list.trim().toLowerCase()) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) || /^%% kanban:settings/.test(lines[i]) || /^\*\*\*/.test(lines[i])) { end = i; break; }
  }
  // insert after the last card in this list section
  let insertAt = start + 1;
  for (let i = start + 1; i < end; i++) if (/^- \[/.test(lines[i])) insertAt = i + 1;
  lines.splice(insertAt, 0, `- [ ] ${card}`);
  return lines.join("\n");
}

function registerCitation(ctx: ToolContext, h: RetrievedChunk): number {
  const existing = ctx.citations.find((c) => c.path === h.path && c.heading === h.heading);
  if (existing) return existing.n;
  const n = ctx.citations.length + 1;
  ctx.citations.push({ ...h, n });
  return n;
}
