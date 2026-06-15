import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Modal, Notice } from "obsidian";
import { VaultMindSettings, DEFAULT_SETTINGS, ChatSession } from "./types";
import { Retriever } from "./agent/retriever";
import { SkillManager } from "./agent/skills";
import { seedDemoVault } from "./agent/seed";
import { MemoryItem } from "./types";
import { UndoEntry } from "./agent/tools";
import { TFile } from "obsidian";
import { AgentView, VIEW_TYPE_VAULT_MIND } from "./ui/AgentView";
import { fetchModels } from "./llm/openrouter";

export default class VaultMindPlugin extends Plugin {
  declare settings: VaultMindSettings;
  retriever!: Retriever;
  skills!: SkillManager;
  sessions: ChatSession[] = [];
  undoStack: UndoEntry[] = [];

  async onload() {
    await this.loadSettings();
    this.retriever = new Retriever(this.app);
    this.retriever.configure(this.settings.useSemantic, this.settings.embedModel);
    this.skills = new SkillManager(this.app, this.settings.skillsFolder);

    // keep the search index fresh: invalidate on vault changes (rebuilds lazily on next search)
    const dirty = () => this.retriever.markDirty();
    this.registerEvent(this.app.vault.on("create", dirty));
    this.registerEvent(this.app.vault.on("modify", dirty));
    this.registerEvent(this.app.vault.on("delete", dirty));
    this.registerEvent(this.app.vault.on("rename", dirty));

    this.registerView(VIEW_TYPE_VAULT_MIND, (leaf) => new AgentView(leaf, this));

    this.addRibbonIcon("brain-circuit", "Open Vault Mind", () => this.activateView());

    this.addCommand({
      id: "open-vault-mind",
      name: "Open Vault Mind agent",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "rebuild-vault-index",
      name: "Rebuild search index",
      callback: async () => {
        this.retriever.configure(this.settings.useSemantic, this.settings.embedModel);
        const notice = new Notice("Vault Mind: indexing…", 0);
        try {
          const n = await this.retriever.build((done, total) => {
            notice.setMessage(`Vault Mind: embedding ${done}/${total} chunks…`);
          });
          notice.setMessage(`Vault Mind: indexed ${n} chunks${this.settings.useSemantic ? " (semantic on)" : ""}.`);
          setTimeout(() => notice.hide(), 3000);
        } catch (e: any) {
          notice.setMessage(`Vault Mind: index failed — ${e?.message || e}`);
          setTimeout(() => notice.hide(), 5000);
        }
      },
    });

    this.addCommand({
      id: "create-sample-skill",
      name: "Create sample skill",
      callback: async () => {
        this.skills.setFolder(this.settings.skillsFolder);
        const path = await this.skills.createSample();
        new Notice(`Vault Mind: sample skill at ${path}`);
        this.app.workspace.openLinkText(path, "/", true);
      },
    });

    this.addCommand({
      id: "undo-agent-edit",
      name: "Undo last agent edit",
      callback: async () => new Notice(`Vault Mind: ${await this.undoLast()}`),
    });

    this.addCommand({
      id: "seed-demo-vault",
      name: "Seed InsideSuccess demo vault",
      callback: async () => {
        const n = await seedDemoVault(this.app);
        this.retriever.markDirty();
        new Notice(`Vault Mind: created ${n} demo notes in "InsideSuccess".`);
      },
    });

    this.addSettingTab(new VaultMindSettingTab(this.app, this));
  }

  onunload() {}

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_VAULT_MIND)[0] || null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_VAULT_MIND, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  // Confirmation gate for agent mutations.
  confirm(title: string, detail: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(this.app, title, detail, resolve).open());
  }

  async loadSettings() {
    const raw = (await this.loadData()) || {};
    // backward compat: old format stored settings fields at the top level
    const settingsSource = raw.settings ? raw.settings : raw;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsSource);
    this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  }
  async saveSettings() {
    await this.persist();
  }
  private async persist() {
    await this.saveData({ settings: this.settings, sessions: this.sessions });
  }

  // ---- session history ----
  upsertSession(s: ChatSession) {
    const i = this.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.sessions[i] = s;
    else this.sessions.unshift(s);
    // cap stored sessions
    if (this.sessions.length > 100) this.sessions = this.sessions.slice(0, 100);
    this.persist();
  }
  deleteSession(id: string) {
    this.sessions = this.sessions.filter((x) => x.id !== id);
    this.persist();
  }

  // ---- long-term memory ----
  remember(text: string) {
    text = (text || "").trim();
    if (!text) return;
    if (this.settings.memories.some((m) => m.text === text)) return;
    this.settings.memories.unshift({ id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, text, createdAt: Date.now() });
    if (this.settings.memories.length > 300) this.settings.memories = this.settings.memories.slice(0, 300);
    this.persist();
  }
  // ---- undo agent file mutations ----
  pushUndo(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 50) this.undoStack.shift();
  }
  async undoLast(): Promise<string> {
    const e = this.undoStack.pop();
    if (!e) return "Nothing to undo.";
    const v = this.app.vault;
    try {
      if (e.op === "create") {
        const f = v.getAbstractFileByPath(e.path!);
        if (f) await v.trash(f, true);
        return `Undid create: removed ${e.path}`;
      }
      if (e.op === "modify") {
        const f = v.getAbstractFileByPath(e.path!);
        if (f instanceof TFile && e.before != null) { await v.modify(f, e.before); return `Restored ${e.path}`; }
        return `Could not restore ${e.path}`;
      }
      if (e.op === "delete") {
        if (e.before != null && !v.getAbstractFileByPath(e.path!)) { await v.create(e.path!, e.before); return `Restored deleted ${e.path}`; }
        return `Could not restore ${e.path}`;
      }
      if (e.op === "move") {
        const f = v.getAbstractFileByPath(e.to!);
        if (f) { await this.app.fileManager.renameFile(f, e.from!); return `Moved back to ${e.from}`; }
        return `Could not move back ${e.to}`;
      }
    } catch (err: any) {
      return `Undo failed: ${err?.message || err}`;
    }
    return "Nothing to undo.";
  }

  recall(query: string): string {
    const q = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.settings.memories
      .map((m) => ({ m, score: q.reduce((s, w) => s + (m.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (!scored.length) return "No relevant memories.";
    return scored.map((x) => `- ${x.m.text}`).join("\n");
  }
}

class ConfirmModal extends Modal {
  private decided = false;
  constructor(app: App, private title: string, private detail: string, private resolve: (b: boolean) => void) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(`Vault Mind · ${this.title}`);
    const pre = this.contentEl.createEl("pre");
    pre.setText(this.detail.slice(0, 800) + (this.detail.length > 800 ? "…" : ""));
    const row = this.contentEl.createDiv();
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.justifyContent = "flex-end";
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.decided = true; this.resolve(false); this.close(); };
    const ok = row.createEl("button", { text: "Confirm", cls: "mod-cta" });
    ok.onclick = () => { this.decided = true; this.resolve(true); this.close(); };
  }
  onClose() {
    if (!this.decided) this.resolve(false);
    this.contentEl.empty();
  }
}

class VaultMindSettingTab extends PluginSettingTab {
  plugin: VaultMindPlugin;
  constructor(app: App, plugin: VaultMindPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("Get one at openrouter.ai/keys. Stored locally in your vault.")
      .addText((t) =>
        t
          .setPlaceholder("sk-or-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          })
          .then((t) => (t.inputEl.type = "password"))
      );

    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc("Default model id. Start typing to search; the chat panel has a fuller picker.")
      .addText((t) => {
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim();
          await this.plugin.saveSettings();
        });
        // attach a datalist for searchable autocomplete
        const listId = "vm-model-datalist";
        const dl = t.inputEl.ownerDocument.createElement("datalist");
        dl.id = listId;
        t.inputEl.setAttribute("list", listId);
        t.inputEl.after(dl);
        t.inputEl.style.minWidth = "240px";
        const addOpt = (id: string) => { const o = document.createElement("option"); o.value = id; dl.appendChild(o); };
        addOpt("openrouter/free");
        fetchModels(this.plugin.settings.apiKey, {})
          .then((models) => {
            for (const m of models) addOpt(m.id);
            modelSetting.setDesc(`Default model id (${models.length} available). Type to search; the chat panel has a fuller picker.`);
          })
          .catch(() => modelSetting.setDesc("Default model id. Could not load list — check API key."));
      });

    const researchModelSetting = new Setting(containerEl)
      .setName("Research model")
      .setDesc("Model for deep_research (deeper/longer). Leave blank to reuse the chat model.")
      .addText((t) => {
        t.setPlaceholder("(use chat model)")
          .setValue(this.plugin.settings.researchModel)
          .onChange(async (v) => {
            this.plugin.settings.researchModel = v.trim();
            await this.plugin.saveSettings();
          });
        const listId = "vm-research-model-datalist";
        const dl = t.inputEl.ownerDocument.createElement("datalist");
        dl.id = listId;
        t.inputEl.setAttribute("list", listId);
        t.inputEl.after(dl);
        t.inputEl.style.minWidth = "240px";
        const addOpt = (id: string) => { const o = document.createElement("option"); o.value = id; dl.appendChild(o); };
        fetchModels(this.plugin.settings.apiKey, {})
          .then((models) => { for (const m of models) addOpt(m.id); })
          .catch(() => researchModelSetting.setDesc("Research model. Could not load list — check API key."));
      });

    new Setting(containerEl)
      .setName("Max research steps")
      .setDesc("Sub-questions investigated per deep_research run.")
      .addSlider((s) =>
        s
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.maxResearchSteps)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxResearchSteps = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Research folder")
      .setDesc("Where deep_research report notes are saved.")
      .addText((t) =>
        t.setValue(this.plugin.settings.researchFolder).onChange(async (v) => {
          this.plugin.settings.researchFolder = v.trim() || "Research";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max agent steps")
      .setDesc("Tool-use iterations before forcing a final answer.")
      .addSlider((s) =>
        s
          .setLimits(2, 16, 1)
          .setValue(this.plugin.settings.maxIterations)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxIterations = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Retrieval depth (top-K)")
      .setDesc("How many chunks search_vault returns per query.")
      .addSlider((s) =>
        s
          .setLimits(3, 15, 1)
          .setValue(this.plugin.settings.topK)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.topK = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Semantic search (local embeddings)")
      .setDesc("Add a dense-vector retrieval channel fused with keyword + graph (RRF). First run downloads a small model (~110MB) and embeds your notes. Run 'Rebuild search index' after enabling.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.useSemantic).onChange(async (v) => {
          this.plugin.settings.useSemantic = v;
          this.plugin.retriever.configure(v, this.plugin.settings.embedModel);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Local transformers.js model for semantic search. Rebuild index after changing.")
      .addDropdown((d) =>
        d
          .addOptions({
            "Xenova/multilingual-e5-small": "multilingual-e5-small (multilingual, default)",
            "Xenova/all-MiniLM-L6-v2": "all-MiniLM-L6-v2 (small, fast, English)",
            "Xenova/bge-small-en-v1.5": "bge-small-en-v1.5 (English, strong)",
            "Xenova/gte-small": "gte-small (English)",
          })
          .setValue(this.plugin.settings.embedModel)
          .onChange(async (v) => {
            this.plugin.settings.embedModel = v;
            this.plugin.retriever.configure(this.plugin.settings.useSemantic, v);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Context compression")
      .setDesc("For long agent runs, summarize gathered evidence into a Knowledge block and drop raw history (sawtooth) to stay within context.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.compressContext).onChange(async (v) => {
          this.plugin.settings.compressContext = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Context budget")
      .setDesc("Compress when the transcript exceeds this many characters (~4 chars ≈ 1 token).")
      .addSlider((s) =>
        s
          .setLimits(6000, 40000, 1000)
          .setValue(this.plugin.settings.contextBudgetChars)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.contextBudgetChars = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow vault editing")
      .setDesc("Let the agent create/update/delete notes, folders and canvases. Destructive actions still ask for confirmation.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.enableWrites).onChange(async (v) => {
          this.plugin.settings.enableWrites = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Plan-then-execute")
      .setDesc("Draft a short plan before acting on complex tasks (more reliable, slightly more tokens).")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.usePlanner).onChange(async (v) => {
          this.plugin.settings.usePlanner = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Connectors" });

    new Setting(containerEl)
      .setName("GitHub repo")
      .setDesc("Default repo as owner/name (e.g. obsidianmd/obsidian-api).")
      .addText((t) =>
        t.setValue(this.plugin.settings.githubRepo).onChange(async (v) => {
          this.plugin.settings.githubRepo = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Optional personal access token (for private repos + higher rate limits).")
      .addText((t) =>
        t
          .setPlaceholder("ghp_...")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (v) => {
            this.plugin.settings.githubToken = v.trim();
            await this.plugin.saveSettings();
          })
          .then((t) => (t.inputEl.type = "password"))
      );

    containerEl.createEl("h3", { text: "Memory & demo" });

    new Setting(containerEl)
      .setName("Long-term memory")
      .setDesc(`${this.plugin.settings.memories.length} stored facts. The agent recalls these across chats.`)
      .addButton((b) =>
        b.setButtonText("Clear").setWarning().onClick(async () => {
          this.plugin.settings.memories = [];
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Seed demo vault")
      .setDesc("Create the connected InsideSuccess.TV substrate (MOCs + cross-linked notes) for demos.")
      .addButton((b) =>
        b.setButtonText("Seed now").onClick(async () => {
          const { seedDemoVault } = await import("./agent/seed");
          const n = await seedDemoVault(this.app);
          this.plugin.retriever.markDirty();
          new Notice(`Created ${n} demo notes in "InsideSuccess".`);
        })
      );

    new Setting(containerEl)
      .setName("Skills folder")
      .setDesc("Folder of skill notes (frontmatter: name, description) the agent can invoke.")
      .addText((t) =>
        t.setValue(this.plugin.settings.skillsFolder).onChange(async (v) => {
          this.plugin.settings.skillsFolder = v.trim() || "Vault Mind Skills";
          this.plugin.skills.setFolder(this.plugin.settings.skillsFolder);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sample skill")
      .setDesc("Create an example skill so you can see the format.")
      .addButton((b) =>
        b.setButtonText("Create sample").onClick(async () => {
          this.plugin.skills.setFolder(this.plugin.settings.skillsFolder);
          const path = await this.plugin.skills.createSample();
          new Notice(`Created ${path}`);
        })
      );
  }
}
