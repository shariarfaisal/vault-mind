import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon, FuzzySuggestModal, TFile } from "obsidian";
import type VaultMindPlugin from "../main";
import { runAgent, AgentEvents, SYSTEM_PROMPT } from "../agent/loop";
import { ToolContext } from "../agent/tools";
import { ChatMessage, RetrievedChunk, OpenRouterModel, ChatSession, Usage, Attachment, ContentPart } from "../types";
import { fetchModels, supportsTools } from "../llm/openrouter";

export const VIEW_TYPE_VAULT_MIND = "vault-mind-view";

interface CompItem {
  label: string;
  sub: string;
  icon: string;
  apply: () => void;
}

export class AgentView extends ItemView {
  plugin: VaultMindPlugin;
  private abort: AbortController | null = null;

  private messages: ChatMessage[] = [];
  private pinned: TFile[] = []; // @context notes
  private attachments: Attachment[] = []; // uploaded images / files
  private attachEl!: HTMLElement;
  private models: OpenRouterModel[] = [];
  private sessionId: string | null = null;
  private historyPopup: HTMLElement | null = null;
  private usageEl!: HTMLElement;
  private sessionTokens = 0;
  private sessionCost = 0;

  // completion popup state (@ notes, / skills)
  private mentionPopup: HTMLElement | null = null;
  private mentionItems: CompItem[] = [];
  private mentionIndex = 0;
  private mentionStart = -1;

  // DOM
  private modelBtn!: HTMLButtonElement;
  private modelPopup: HTMLElement | null = null;
  private modelSearchValue = "";
  private modelFilterFree = false;
  private modelFilterTools = false;
  private threadEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private chipsEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: VaultMindPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_VAULT_MIND; }
  getDisplayText() { return "Vault Mind"; }
  getIcon() { return "brain-circuit"; }

  async onOpen() { this.render(); }
  async onClose() { this.stop(); this.closeModelPopup(); this.closeMention(); this.closeHistory(); }

  private render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-mind");
    if (!this.plugin.settings.apiKey) this.renderSetup(root);
    else this.renderChat(root);
  }

  // ---------- API key setup ----------
  private renderSetup(root: HTMLElement) {
    const card = root.createDiv("vm-setup");
    const h = card.createDiv("vm-setup-head");
    setIcon(h.createSpan("vm-setup-icon"), "brain-circuit");
    h.createEl("div", { text: "Vault Mind", cls: "vm-setup-title" });
    card.createEl("p", { text: "An agent that reasons across your vault. Add an OpenRouter API key to start.", cls: "vm-setup-sub" });
    const key = card.createEl("input", { cls: "vm-setup-input", attr: { type: "password", placeholder: "sk-or-..." } });
    const save = card.createEl("button", { text: "Save & start", cls: "mod-cta vm-setup-btn" });
    const go = async () => {
      const v = key.value.trim();
      if (!v) { new Notice("Paste an OpenRouter API key."); return; }
      this.plugin.settings.apiKey = v;
      await this.plugin.saveSettings();
      this.render();
    };
    save.onclick = go;
    key.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    const link = card.createEl("a", { text: "Get a key at openrouter.ai/keys →", cls: "vm-setup-link" });
    link.href = "https://openrouter.ai/keys";
  }

  // ---------- Chat ----------
  private renderChat(root: HTMLElement) {
    // top bar (brand + new chat + settings)
    const header = root.createDiv("vm-topbar");
    const brand = header.createDiv("vm-brand");
    setIcon(brand.createSpan("vm-brand-icon"), "brain-circuit");
    brand.createSpan({ text: "Vault Mind" });
    this.usageEl = header.createDiv("vm-usage");
    this.updateUsageReadout();
    const actions = header.createDiv("vm-actions");
    iconBtn(actions, "plus", "New chat").onclick = () => this.resetChat();
    iconBtn(actions, "history", "Chat history").onclick = (e) => { e.stopPropagation(); this.toggleHistory(); };
    iconBtn(actions, "copy", "Copy whole conversation").onclick = () => this.copyAll();
    iconBtn(actions, "download", "Export this chat").onclick = () => this.exportChat();
    iconBtn(actions, "settings", "Settings").onclick = () => {
      const s = (this.app as any).setting;
      s?.open?.(); s?.openTabById?.("vault-mind");
    };

    // thread
    this.threadEl = root.createDiv("vm-thread");
    if (!this.messages.length) {
      this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
      this.renderEmptyState();
    } else this.replayThread();

    // composer card (big input + toolbar below)
    const card = root.createDiv("vm-composer");
    this.chipsEl = card.createDiv("vm-context-chips");
    this.renderChips();
    this.attachEl = card.createDiv("vm-attachments");
    this.renderAttachments();

    this.input = card.createEl("textarea", {
      cls: "vm-input",
      attr: { placeholder: "Ask or instruct…  @ note · / skill · Enter to send", rows: "3" },
    });
    this.input.addEventListener("input", () => { this.autosize(); this.updateMention(); });
    this.input.addEventListener("keydown", (e) => {
      if (this.mentionPopup) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.moveMention(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.moveMention(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this.chooseMention(this.mentionIndex); return; }
        if (e.key === "Escape") { e.preventDefault(); this.closeMention(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.ask(); }
    });
    this.input.addEventListener("blur", () => setTimeout(() => this.closeMention(), 150));
    this.input.addEventListener("paste", (e) => this.handlePaste(e));

    const bar = card.createDiv("vm-toolbar");
    const addCtx = iconBtn(bar, "plus", "Add note as context");
    addCtx.addClass("vm-tool-icon");
    addCtx.onclick = () => this.pickContext();

    const attachBtn = iconBtn(bar, "paperclip", "Attach image or file");
    attachBtn.addClass("vm-tool-icon");
    attachBtn.onclick = () => this.pickFiles();

    this.modelBtn = bar.createEl("button", { cls: "vm-model" });
    this.modelBtn.onclick = (e) => { e.stopPropagation(); this.toggleModelPopup(); };
    this.setModelLabel();

    const spacer = bar.createDiv("vm-spacer");
    this.sendBtn = bar.createEl("button", { cls: "vm-send" });
    this.sendBtn.title = "Send";
    setIcon(this.sendBtn.createSpan("vm-send-ico"), "send-horizontal");
    this.sendBtn.onclick = () => (this.abort ? this.stop() : this.ask());

    this.autosize();
    // auto-load models once
    if (!this.models.length) this.loadModels();
  }

  private autosize() {
    if (!this.input) return;
    this.input.style.height = "auto";
    this.input.style.height = Math.min(Math.max(this.input.scrollHeight, 72), 220) + "px";
  }

  private renderEmptyState() {
    const empty = this.threadEl.createDiv("vm-empty");
    empty.createEl("div", { text: "Ask me anything about your notes.", cls: "vm-empty-title" });
    const chips = empty.createDiv("vm-chips");
    for (const s of this.suggestedPrompts()) {
      const c = chips.createEl("button", { text: s, cls: "vm-chip" });
      c.onclick = () => { this.input.value = s; this.autosize(); this.ask(); };
    }
  }

  // Build starter prompts from the actual vault so chips feel personal.
  // Falls back to generic prompts when the vault is empty.
  private suggestedPrompts(): string[] {
    const STATIC = [
      "Find a surprising connection between two unrelated notes.",
      "What have I been working on lately, and what's still unfinished?",
      "Summarize what I know about a topic — and cite the notes.",
    ];
    const files = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(".") && f.extension === "md");
    if (files.length < 2) return STATIC;

    // Two notes from different folders → highlights cross-domain graph traversal.
    const byFolder = new Map<string, string[]>();
    for (const f of files) {
      const dir = f.parent?.path || "/";
      if (!byFolder.has(dir)) byFolder.set(dir, []);
      byFolder.get(dir)!.push(f.basename);
    }
    const folders = [...byFolder.keys()];
    const pick = (arr: string[], i: number) => arr[i % arr.length];
    let noteA: string, noteB: string;
    if (folders.length >= 2) {
      noteA = pick(byFolder.get(folders[0])!, 0);
      noteB = pick(byFolder.get(folders[1])!, 0);
    } else {
      noteA = files[0].basename;
      noteB = files[Math.min(1, files.length - 1)].basename;
    }

    // A meaningful top-level folder for a scoped summary.
    const topFolders = folders
      .map((p) => p.split("/")[0])
      .filter((p) => p && p !== "/" && !p.startsWith("."));
    const topFolder = topFolders.sort(
      (a, b) => (byFolder.get(b)?.length || 0) - (byFolder.get(a)?.length || 0)
    )[0];

    const out: string[] = [];
    if (noteA && noteB && noteA !== noteB) out.push(`What connects [[${noteA}]] and [[${noteB}]]?`);
    if (topFolder) out.push(`Summarize everything in "${topFolder}" and cite the notes.`);
    out.push("Research a topic and write me a cited report.");
    out.push("What have I been working on lately, and what's still unfinished?");
    return out.slice(0, 4);
  }

  private resetChat() {
    this.stop();
    this.sessionId = null;
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.pinned = [];
    this.attachments = [];
    this.renderChips();
    this.renderAttachments();
    this.threadEl.empty();
    this.renderEmptyState();
  }

  // persist the current conversation as a session
  private saveSession() {
    const firstUser = this.messages.find((m) => m.role === "user");
    if (!firstUser) return;
    const now = Date.now();
    if (!this.sessionId) this.sessionId = `${now}-${Math.floor(Math.random() * 1e6)}`;
    const title = truncate((msgText(firstUser.content) || "Chat").split("\n")[0], 60);
    const session: ChatSession = {
      id: this.sessionId,
      title,
      createdAt: now,
      updatedAt: now,
      messages: this.messages,
    };
    this.plugin.upsertSession(session);
  }

  // ---------- history ----------
  private toggleHistory() {
    if (this.historyPopup) { this.closeHistory(); return; }
    const pop = this.contentEl.createDiv("vm-history-popup");
    this.historyPopup = pop;
    pop.createDiv("vm-history-head").setText("Chat history");
    const list = pop.createDiv("vm-history-list");
    const sessions = [...this.plugin.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!sessions.length) list.createDiv("vm-history-empty").setText("No saved chats yet.");
    for (const s of sessions) {
      const row = list.createDiv("vm-history-item");
      const main = row.createDiv("vm-history-main");
      main.createDiv("vm-history-title").setText(s.title);
      main.createDiv("vm-history-date").setText(relTime(s.updatedAt));
      main.onclick = () => { this.loadSession(s); this.closeHistory(); };
      const del = row.createSpan("vm-history-del");
      setIcon(del, "trash-2");
      del.onclick = (e) => {
        e.stopPropagation();
        this.plugin.deleteSession(s.id);
        row.remove();
        if (this.sessionId === s.id) this.sessionId = null;
      };
    }
    this._histOutside = (ev: MouseEvent) => {
      if (this.historyPopup && !this.historyPopup.contains(ev.target as Node)) this.closeHistory();
    };
    setTimeout(() => document.addEventListener("mousedown", this._histOutside!), 0);
  }
  private _histOutside: ((e: MouseEvent) => void) | null = null;
  private closeHistory() {
    if (this.historyPopup) { this.historyPopup.remove(); this.historyPopup = null; }
    if (this._histOutside) { document.removeEventListener("mousedown", this._histOutside); this._histOutside = null; }
  }

  private loadSession(s: ChatSession) {
    this.stop();
    this.sessionId = s.id;
    this.messages = s.messages.map((m) => ({ ...m }));
    this.pinned = [];
    this.renderChips();
    this.replayThread();
  }

  // ---------- export ----------
  private async exportChat() {
    const turns = this.messages.filter((m) => m.role === "user" || (m.role === "assistant" && m.content));
    if (!turns.length) { new Notice("Nothing to export yet."); return; }
    const title = truncate((msgText(this.messages.find((m) => m.role === "user")?.content) || "Vault Mind chat").split("\n")[0], 60);
    const lines = [`# ${title}`, "", `> Exported from Vault Mind · model: ${this.plugin.settings.model}`, ""];
    for (const m of turns) {
      lines.push(m.role === "user" ? `## 🧑 You` : `## 🧠 Vault Mind`);
      lines.push("", msgText(m.content).trim(), "");
    }
    const folder = "Vault Mind Chats";
    const safe = title.replace(/[\\/:*?"<>|]/g, "-");
    const path = `${folder}/${safe}.md`;
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.modify(file, lines.join("\n"));
    else file = await this.app.vault.create(path, lines.join("\n"));
    new Notice(`Exported to ${path}`);
    this.app.workspace.openLinkText(path, "/", true);
  }

  private replayThread() {
    this.threadEl.empty();
    for (const m of this.messages) {
      if (m.role === "user") this.addUserBubble(msgText(m.content), msgImages(m.content));
      else if (m.role === "assistant" && typeof m.content === "string" && m.content) {
        const b = this.addAssistantBubble();
        b.status.remove();
        MarkdownRenderer.render(this.app, m.content, b.answer, "/", this.plugin);
        this.wireInternalLinks(b.answer);
        this.addMessageActions(b.answer, m.content);
      }
    }
  }

  // ---------- context mentions ----------
  private pickContext() {
    new NotePickerModal(this.plugin, (file) => {
      if (file && !this.pinned.includes(file)) {
        this.pinned.push(file);
        this.renderChips();
      }
    }).open();
  }

  private renderChips() {
    this.chipsEl.empty();
    if (!this.pinned.length) { this.chipsEl.hide(); return; }
    this.chipsEl.show();
    for (const f of this.pinned) {
      const chip = this.chipsEl.createDiv("vm-ctx-chip");
      setIcon(chip.createSpan("vm-ctx-icon"), "file-text");
      chip.createSpan({ text: f.basename });
      const x = chip.createSpan("vm-ctx-x");
      setIcon(x, "x");
      x.onclick = () => {
        this.pinned = this.pinned.filter((p) => p !== f);
        this.renderChips();
      };
    }
  }

  // ---------- agent → user clarifying question ----------
  private askUserCard(question: string, options: string[], multiple: boolean): Promise<string> {
    return new Promise((resolve) => {
      const card = this.threadEl.createDiv("vm-ask-card");
      const head = card.createDiv("vm-ask-head");
      setIcon(head.createSpan("vm-ask-ico"), "help-circle");
      head.createSpan({ text: "Vault Mind needs input", cls: "vm-ask-label" });
      card.createDiv("vm-ask-q").setText(question);

      let done = false;
      const finish = (answer: string) => {
        if (done) return;
        done = true;
        // collapse the card to a compact one-line summary
        card.empty();
        card.addClass("vm-ask-answered");
        const row = card.createDiv("vm-ask-collapsed");
        setIcon(row.createSpan("vm-ask-ico"), "check-circle");
        row.createSpan({ text: truncate(question, 48), cls: "vm-ask-collapsed-q" });
        setIcon(row.createSpan("vm-ask-answer-ico"), "corner-down-right");
        row.createSpan({ text: answer || "(dismissed)", cls: "vm-ask-collapsed-a" });
        resolve(answer);
      };

      const opts = card.createDiv("vm-ask-options");
      const selected = new Set<string>();
      for (const o of options) {
        const b = opts.createEl("button", { text: o, cls: "vm-ask-opt" });
        b.onclick = () => {
          if (multiple) {
            if (selected.has(o)) { selected.delete(o); b.removeClass("is-selected"); }
            else { selected.add(o); b.addClass("is-selected"); }
          } else {
            finish(o);
          }
        };
      }

      const row = card.createDiv("vm-ask-row");
      const input = row.createEl("input", {
        cls: "vm-ask-input",
        attr: { type: "text", placeholder: multiple ? "Or type your own…" : "Type an answer…" },
      });
      const send = row.createEl("button", { cls: "vm-ask-send", text: multiple ? "Submit" : "Send" });
      const submit = () => {
        const typed = input.value.trim();
        if (multiple) {
          const parts = [...selected];
          if (typed) parts.push(typed);
          finish(parts.join(", "));
        } else {
          if (typed) finish(typed);
        }
      };
      send.onclick = submit;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });

      this.scrollDown();
      setTimeout(() => input.focus(), 0);
    });
  }

  // ---------- attachments (upload / paste) ----------
  private pickFiles() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.multiple = true;
    inp.accept = "image/*,.md,.txt,.json,.csv,.log";
    inp.onchange = async () => {
      if (inp.files) for (const f of Array.from(inp.files)) await this.addFile(f);
    };
    inp.click();
  }

  private async handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    let handled = false;
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) { await this.addFile(f); handled = true; }
      }
    }
    if (handled) e.preventDefault();
  }

  private async addFile(file: File) {
    const isImage = file.type.startsWith("image/");
    if (isImage) {
      const dataUrl = await readAsDataURL(file);
      this.attachments.push({ name: file.name || "image", kind: "image", dataUrl });
    } else {
      const text = await file.text();
      this.attachments.push({ name: file.name || "file", kind: "text", text: text.slice(0, 12000) });
    }
    this.renderAttachments();
  }

  private renderAttachments() {
    if (!this.attachEl) return;
    this.attachEl.empty();
    if (!this.attachments.length) { this.attachEl.hide(); return; }
    this.attachEl.show();
    this.attachments.forEach((a, i) => {
      const chip = this.attachEl.createDiv("vm-attach-chip");
      if (a.kind === "image" && a.dataUrl) {
        const img = chip.createEl("img", { cls: "vm-attach-thumb" });
        img.src = a.dataUrl;
      } else {
        setIcon(chip.createSpan("vm-attach-ico"), "file-text");
      }
      chip.createSpan({ text: truncate(a.name, 18), cls: "vm-attach-name" });
      const x = chip.createSpan("vm-attach-x");
      setIcon(x, "x");
      x.onclick = () => { this.attachments.splice(i, 1); this.renderAttachments(); };
    });
  }

  // ---------- completion autocomplete (@ notes, / skills) ----------
  private updateMention() {
    const pos = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, pos);

    // @ → mention a note
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const q = at[1].toLowerCase();
      this.mentionStart = pos - at[1].length - 1;
      this.mentionItems = this.app.vault
        .getMarkdownFiles()
        .filter((f) => !q || f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        .slice(0, 8)
        .map((f) => ({
          label: f.basename,
          sub: f.parent?.path && f.parent.path !== "/" ? f.parent.path : "",
          icon: "file-text",
          apply: () => { if (!this.pinned.includes(f)) { this.pinned.push(f); this.renderChips(); } this.stripToken(pos); },
        }));
      if (!this.mentionItems.length) return this.closeMention();
      this.mentionIndex = 0;
      return this.showMention();
    }

    // / at line start → run a skill
    const slash = before.match(/^\/([^\s/]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      this.mentionStart = 0;
      this.plugin.skills.setFolder(this.plugin.settings.skillsFolder);
      this.mentionItems = this.plugin.skills
        .list()
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((s) => ({
          label: s.name,
          sub: s.description,
          icon: "wand-2",
          apply: () => {
            const rest = this.input.value.slice(pos);
            this.input.value = `Use the "${s.name}" skill. ` + rest;
            this.input.setSelectionRange(this.input.value.length, this.input.value.length);
            this.autosize();
          },
        }));
      if (!this.mentionItems.length) return this.closeMention();
      this.mentionIndex = 0;
      return this.showMention();
    }

    this.closeMention();
  }

  private stripToken(pos: number) {
    const val = this.input.value;
    this.input.value = val.slice(0, this.mentionStart) + val.slice(pos);
    this.input.setSelectionRange(this.mentionStart, this.mentionStart);
    this.autosize();
  }

  private showMention() {
    if (!this.mentionPopup) this.mentionPopup = this.contentEl.createDiv("vm-mention-popup");
    const pop = this.mentionPopup;
    pop.empty();
    this.mentionItems.forEach((it, i) => {
      const item = pop.createDiv("vm-mention-item" + (i === this.mentionIndex ? " is-active" : ""));
      setIcon(item.createSpan("vm-mention-icon"), it.icon);
      item.createSpan({ text: it.label, cls: "vm-mention-name" });
      item.createSpan({ text: it.sub, cls: "vm-mention-path" });
      item.onmousedown = (e) => { e.preventDefault(); this.chooseMention(i); };
    });
    const r = this.input.getBoundingClientRect();
    const cr = this.contentEl.getBoundingClientRect();
    pop.style.left = r.left - cr.left + "px";
    pop.style.width = r.width + "px";
    pop.style.bottom = cr.bottom - r.top + 4 + "px";
  }

  private moveMention(d: number) {
    this.mentionIndex = (this.mentionIndex + d + this.mentionItems.length) % this.mentionItems.length;
    this.showMention();
  }

  private chooseMention(i: number) {
    this.mentionItems[i]?.apply();
    this.closeMention();
    this.input.focus();
  }

  private closeMention() {
    if (this.mentionPopup) { this.mentionPopup.remove(); this.mentionPopup = null; }
    this.mentionItems = [];
    this.mentionStart = -1;
  }

  // ---------- model picker (searchable, height-capped) ----------
  private setModelLabel() {
    if (!this.modelBtn) return;
    this.modelBtn.empty();
    setIcon(this.modelBtn.createSpan("vm-model-ico"), "bot");
    this.modelBtn.createSpan({ text: shortModel(this.plugin.settings.model), cls: "vm-model-name" });
    setIcon(this.modelBtn.createSpan("vm-model-caret"), "chevron-down");
  }

  private async loadModels() {
    try {
      // always load the full list; filtering happens in the popup
      this.models = await fetchModels(this.plugin.settings.apiKey, {});
      if (this.modelPopup) this.renderModelList(this.modelSearchValue);
    } catch (e: any) {
      new Notice(`Vault Mind: ${e?.message || e}`);
    }
  }

  private toggleModelPopup() {
    if (this.modelPopup) { this.closeModelPopup(); return; }
    const pop = this.contentEl.createDiv("vm-model-popup");
    this.modelPopup = pop;
    const search = pop.createEl("input", { cls: "vm-model-search", attr: { placeholder: "Search models…", type: "text" } });
    search.value = this.modelSearchValue;
    // filter chips
    const filters = pop.createDiv("vm-model-filters");
    const freeChip = filters.createEl("button", { text: "Free only", cls: "vm-filter-chip" + (this.modelFilterFree ? " is-on" : "") });
    const toolChip = filters.createEl("button", { text: "Tools only", cls: "vm-filter-chip" + (this.modelFilterTools ? " is-on" : "") });
    freeChip.onclick = () => { this.modelFilterFree = !this.modelFilterFree; freeChip.toggleClass("is-on", this.modelFilterFree); this.renderModelList(search.value); };
    toolChip.onclick = () => { this.modelFilterTools = !this.modelFilterTools; toolChip.toggleClass("is-on", this.modelFilterTools); this.renderModelList(search.value); };
    pop.createDiv("vm-model-list");
    search.addEventListener("input", () => { this.modelSearchValue = search.value; this.renderModelList(search.value); });
    this.renderModelList(this.modelSearchValue);
    if (!this.models.length) this.loadModels();

    // position above the model button
    const r = this.modelBtn.getBoundingClientRect();
    const cr = this.contentEl.getBoundingClientRect();
    pop.style.left = Math.max(4, r.left - cr.left) + "px";
    pop.style.bottom = cr.bottom - r.top + 4 + "px";

    setTimeout(() => search.focus(), 0);
    // outside click closes
    this._outside = (ev: MouseEvent) => {
      if (this.modelPopup && !this.modelPopup.contains(ev.target as Node) && ev.target !== this.modelBtn) this.closeModelPopup();
    };
    document.addEventListener("mousedown", this._outside);
  }

  private renderModelList(query: string) {
    if (!this.modelPopup) return;
    const list = this.modelPopup.querySelector(".vm-model-list") as HTMLElement;
    if (!list) return;
    list.empty();
    const q = query.toLowerCase();
    const entries: { id: string; label: string; tools: boolean; free: boolean }[] = [
      { id: "openrouter/free", label: "openrouter/free (auto)", tools: true, free: true },
      ...this.models.map((m) => ({ id: m.id, label: m.id, tools: supportsTools(m), free: m.id.endsWith(":free") })),
    ];
    const filtered = entries.filter(
      (e) => (!q || e.id.toLowerCase().includes(q)) && (!this.modelFilterFree || e.free) && (!this.modelFilterTools || e.tools)
    );
    if (!filtered.length) { list.createDiv("vm-model-empty").setText(this.models.length ? "No models match." : "Loading models…"); return; }
    for (const e of filtered.slice(0, 300)) {
      const item = list.createDiv("vm-model-item" + (e.id === this.plugin.settings.model ? " is-active" : ""));
      item.createSpan({ text: e.label, cls: "vm-model-item-name" });
      const tags = item.createSpan("vm-model-tags");
      if (e.free) tags.createSpan({ text: "free", cls: "vm-tag vm-tag-free" });
      if (e.tools) tags.createSpan({ text: "tools", cls: "vm-tag vm-tag-tools" });
      else tags.createSpan({ text: "no tools", cls: "vm-tag vm-tag-warn" });
      item.onclick = async () => {
        this.plugin.settings.model = e.id;
        await this.plugin.saveSettings();
        this.setModelLabel();
        this.closeModelPopup();
      };
    }
  }

  private _outside: ((e: MouseEvent) => void) | null = null;
  private closeModelPopup() {
    if (this.modelPopup) { this.modelPopup.remove(); this.modelPopup = null; }
    if (this._outside) { document.removeEventListener("mousedown", this._outside); this._outside = null; }
  }

  // ---------- bubbles ----------
  private addUserBubble(text: string, images: string[] = []) {
    const row = this.threadEl.createDiv("vm-msg vm-msg-user");
    const bubble = row.createDiv("vm-bubble");
    if (text) bubble.createDiv("vm-bubble-text").setText(text);
    if (images.length) {
      const grid = bubble.createDiv("vm-bubble-imgs");
      for (const url of images) {
        const img = grid.createEl("img", { cls: "vm-bubble-img" });
        img.src = url;
      }
    }
    this.scrollDown();
  }

  private addAssistantBubble() {
    const row = this.threadEl.createDiv("vm-msg vm-msg-assistant");
    setIcon(row.createDiv("vm-avatar"), "brain-circuit");
    const body = row.createDiv("vm-bubble vm-bubble-assistant");
    const status = body.createDiv("vm-msg-status");
    const toggle = body.createDiv("vm-trace-toggle");
    toggle.setText("▸ Working…");
    const trace = body.createDiv("vm-trace");
    trace.style.display = "none";
    toggle.onclick = () => {
      const open = trace.style.display !== "none";
      trace.style.display = open ? "none" : "block";
      toggle.setText((open ? "▸" : "▾") + toggle.getText().slice(1));
    };
    const answer = body.createDiv("vm-answer");
    this.scrollDown();
    return { trace, toggle, answer, status };
  }

  private scrollDown() { this.threadEl.scrollTop = this.threadEl.scrollHeight; }

  private updateUsageReadout() {
    if (!this.usageEl) return;
    this.usageEl.empty();
    if (!this.sessionTokens) { this.usageEl.hide(); return; }
    this.usageEl.show();
    this.usageEl.setText(`${fmtTokens(this.sessionTokens)} · ${fmtCost(this.sessionCost)}`);
    this.usageEl.title = `Session total: ${this.sessionTokens.toLocaleString()} tokens · ${fmtCost(this.sessionCost)}`;
  }

  // ---------- ask ----------
  private setBusy(busy: boolean) {
    this.input.disabled = busy;
    const ico = this.sendBtn.querySelector(".vm-send-ico") as HTMLElement;
    if (ico) setIcon(ico, busy ? "square" : "send-horizontal");
    this.sendBtn.title = busy ? "Stop" : "Send";
    this.sendBtn.toggleClass("vm-send-stop", busy);
  }

  private stop() {
    if (this.abort) { this.abort.abort(); this.abort = null; this.setBusy(false); }
  }

  private async buildContextPreface(): Promise<string> {
    if (!this.pinned.length) return "";
    const parts: string[] = ["The user pinned these notes as required context:"];
    for (const f of this.pinned) {
      const body = await this.app.vault.cachedRead(f);
      parts.push(`\n## [[${f.basename}]] (${f.path})\n${body.slice(0, 3000)}`);
    }
    return parts.join("\n");
  }

  private async ask() {
    const q = this.input.value.trim();
    if ((!q && !this.attachments.length) || this.abort) return;
    this.threadEl.querySelector(".vm-empty")?.remove();

    const mentions = this.pinned.map((f) => `[[${f.basename}]]`).join(" ");
    const images = this.attachments.filter((a) => a.kind === "image" && a.dataUrl).map((a) => a.dataUrl!);
    this.addUserBubble(mentions ? `${q}\n${mentions}` : q, images);

    // assemble the text portion: pinned-note context + uploaded text files + question
    const preface = await this.buildContextPreface();
    const fileText = this.attachments
      .filter((a) => a.kind === "text" && a.text)
      .map((a) => `Attached file: ${a.name}\n${a.text}`)
      .join("\n\n");
    let textBlock = q;
    if (fileText) textBlock = `${fileText}\n\n---\n${q}`;
    const mem = this.plugin.recall(q);
    if (mem && !mem.startsWith("No relevant")) textBlock = `Relevant long-term memory:\n${mem}\n\n---\n${textBlock}`;
    if (preface) textBlock = `${preface}\n\n---\nQuestion: ${textBlock}`;

    // multimodal if images attached, else plain string
    if (images.length) {
      const parts: ContentPart[] = [{ type: "text", text: textBlock }];
      for (const url of images) parts.push({ type: "image_url", image_url: { url } });
      this.messages.push({ role: "user", content: parts });
    } else {
      this.messages.push({ role: "user", content: textBlock });
    }

    this.attachments = [];
    this.renderAttachments();
    this.input.value = "";
    this.autosize();
    this.setBusy(true);
    this.abort = new AbortController();

    const bubble = this.addAssistantBubble();
    const citations: RetrievedChunk[] = [];
    const touched: string[] = [];
    this.plugin.skills.setFolder(this.plugin.settings.skillsFolder);
    const toolCtx: ToolContext = {
      app: this.app,
      retriever: this.plugin.retriever,
      settings: this.plugin.settings,
      citations,
      skills: this.plugin.skills,
      confirm: (title, detail) => this.plugin.confirm(title, detail),
      askUser: (q, opts, multi) => this.askUserCard(q, opts, multi),
      remember: (t) => this.plugin.remember(t),
      recall: (q) => this.plugin.recall(q),
      pushUndo: (e) => this.plugin.pushUndo(e),
      onFileTouched: (p) => { if (!touched.includes(p)) touched.push(p); },
      // nested LLM usage (deep_research sub-loop) — count into the session totals
      onUsage: (u) => {
        this.sessionTokens += u.total_tokens || 0;
        this.sessionCost += u.cost || 0;
        this.updateUsageReadout();
      },
      // progress lines from long-running tools (deep_research phases)
      onResearchStep: (label) => {
        bubble.status.setText(label);
        const line = bubble.trace.createDiv("vm-trace-line vm-think");
        line.setText(label);
        bubble.trace.style.display = "block";
        this.scrollDown();
      },
      signal: this.abort.signal,
    };

    let liveEl: HTMLElement | null = null; // live-streaming text in the answer area
    let currentCard: { badge: HTMLElement; body: HTMLElement } | null = null;
    let lastUsage: Usage | null = null;
    const events: AgentEvents = {
      onUsage: (u) => {
        lastUsage = u;
        this.sessionTokens += u.total_tokens || 0;
        this.sessionCost += u.cost || 0;
        this.updateUsageReadout();
      },
      onIteration: (i, max) => bubble.status.setText(`Thinking · step ${i}/${max}`),
      onCompress: (freed) => {
        const card = bubble.trace.createDiv("vm-step vm-step-compress");
        const head = card.createDiv("vm-step-head");
        setIcon(head.createSpan("vm-step-ico"), "archive");
        head.createSpan({ text: "Compressed context", cls: "vm-step-title" });
        head.createSpan({ text: `freed ~${Math.round(freed / 1000)}k`, cls: "vm-step-badge" });
        bubble.trace.style.display = "block";
        this.scrollDown();
      },
      onThinkingToken: (t) => {
        // stream tokens live into the answer area (feels alive)
        if (!liveEl) liveEl = bubble.answer.createDiv("vm-live");
        liveEl.setText((liveEl.getText() || "") + t);
        this.scrollDown();
      },
      onToolCall: (name, args) => {
        // text streamed before a tool call was interim reasoning → move it to the trace
        if (liveEl) {
          const txt = liveEl.getText();
          if (txt.trim()) bubble.trace.createDiv("vm-trace-line vm-think").setText(txt);
          liveEl.remove();
          liveEl = null;
        }
        bubble.status.setText(`${friendlyVerb(name)}…`);
        bubble.trace.style.display = "block";
        const card = bubble.trace.createDiv("vm-step");
        const head = card.createDiv("vm-step-head");
        setIcon(head.createSpan("vm-step-ico"), toolIcon(name));
        head.createSpan({ text: friendlyTitle(name, args), cls: "vm-step-title" });
        const badge = head.createSpan("vm-step-badge");
        badge.setText("…");
        const chev = head.createSpan("vm-step-chev");
        setIcon(chev, "chevron-right");
        const body = card.createDiv("vm-step-body");
        body.hide();
        head.onclick = () => {
          const open = body.isShown();
          body.toggle(!open);
          card.toggleClass("is-open", !open);
        };
        currentCard = { badge, body };
        this.scrollDown();
      },
      onToolResult: (name, result) => {
        if (currentCard) {
          const err = result.startsWith("Error") || result.startsWith("No matching");
          currentCard.badge.setText(summarizeResult(name, result));
          currentCard.badge.toggleClass("vm-step-badge-err", err);
          currentCard.body.createEl("pre", { cls: "vm-step-pre" }).setText(truncate(result, 4000));
          currentCard = null;
        }
        this.scrollDown();
      },
      onFinal: async (text) => {
        bubble.status.remove();
        bubble.toggle.setText("▸ Show work");
        bubble.trace.style.display = "none";
        if (liveEl) { liveEl.remove(); liveEl = null; }
        bubble.answer.empty();
        await MarkdownRenderer.render(this.app, text, bubble.answer, "/", this.plugin);
        this.wireInternalLinks(bubble.answer);
        this.renderTouched(bubble.answer, touched);
        this.renderCitations(bubble.answer, citations);
        this.addMessageActions(bubble.answer, text);
        // auto-open files the agent created/modified this turn
        for (const p of touched) this.app.workspace.openLinkText(p, "/", false);
        if (lastUsage) {
          const u = lastUsage;
          const foot = bubble.answer.createDiv("vm-usage-foot");
          foot.setText(`${fmtTokens(u.total_tokens)} tokens · ${fmtCost(u.cost)}`);
          foot.title = `prompt ${u.prompt_tokens.toLocaleString()} · completion ${u.completion_tokens.toLocaleString()} · ${fmtCost(u.cost)}`;
        }
        this.messages.push({ role: "assistant", content: text });
        this.saveSession();
        this.setBusy(false);
        this.abort = null;
        this.scrollDown();
      },
      onError: (msg) => {
        bubble.status.remove();
        bubble.answer.createDiv("vm-error").setText(`⚠️ ${msg}`);
        this.setBusy(false);
        this.abort = null;
      },
    };

    const working = [...this.messages];
    await runAgent(working, this.plugin.settings, toolCtx, events, this.abort.signal);
  }

  // Make [[wikilinks]] / internal links in a rendered answer open their note on click.
  private wireInternalLinks(container: HTMLElement) {
    container.querySelectorAll<HTMLElement>("a.internal-link").forEach((a) => {
      const href = a.getAttribute("data-href") || a.getAttribute("href") || a.textContent || "";
      a.onclick = (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(href, "/", e.ctrlKey || e.metaKey);
      };
    });
  }

  // Show pills for files the agent created/modified, with open-on-click.
  private renderTouched(container: HTMLElement, touched: string[]) {
    if (!touched.length) return;
    const box = container.createDiv("vm-touched");
    box.createSpan({ text: "Files changed:", cls: "vm-touched-label" });
    for (const p of touched) {
      const pill = box.createEl("a", { cls: "vm-touched-pill" });
      setIcon(pill.createSpan("vm-touched-ico"), p.endsWith(".canvas") ? "layout-dashboard" : "file-text");
      pill.createSpan({ text: p.split("/").pop()! });
      pill.onclick = (e) => { e.preventDefault(); this.app.workspace.openLinkText(p, "/", true); };
    }
    const undo = box.createEl("button", { cls: "vm-touched-undo" });
    setIcon(undo.createSpan("vm-touched-ico"), "undo-2");
    undo.createSpan({ text: "Undo" });
    undo.onclick = async () => { new Notice(await this.plugin.undoLast()); };
  }

  private addMessageActions(container: HTMLElement, text: string) {
    const row = container.createDiv("vm-msg-actions");
    const copy = row.createEl("button", { cls: "vm-act-btn" });
    setIcon(copy.createSpan("vm-act-ico"), "copy");
    copy.createSpan({ text: "Copy" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(text);
      copy.querySelector(".vm-act-ico")?.empty();
      setIcon(copy.querySelector(".vm-act-ico") as HTMLElement, "check");
      new Notice("Copied message");
      setTimeout(() => { const i = copy.querySelector(".vm-act-ico") as HTMLElement; if (i) { i.empty(); setIcon(i, "copy"); } }, 1200);
    };
  }

  private async copyAll() {
    const turns = this.messages.filter((m) => m.role === "user" || (m.role === "assistant" && typeof m.content === "string" && m.content));
    if (!turns.length) { new Notice("Nothing to copy yet."); return; }
    const md = turns.map((m) => `**${m.role === "user" ? "You" : "Vault Mind"}:**\n${msgText(m.content)}`).join("\n\n---\n\n");
    await navigator.clipboard.writeText(md);
    new Notice("Copied conversation to clipboard");
  }

  private renderCitations(container: HTMLElement, citations: RetrievedChunk[]) {
    if (!citations.length) return;
    const box = container.createDiv("vm-sources");
    const head = box.createDiv("vm-sources-head");
    setIcon(head.createSpan("vm-sources-ico"), "link");
    head.createSpan({ text: "Sources", cls: "vm-sources-title" });
    head.createSpan({ text: `${citations.length}`, cls: "vm-sources-count" });
    const chev = head.createSpan("vm-sources-chev");
    setIcon(chev, "chevron-down");
    const list = box.createDiv("vm-sources-list");
    head.onclick = () => { const open = list.isShown(); list.toggle(!open); box.toggleClass("is-collapsed", open); };
    for (const c of citations) {
      const base = c.path.split("/").pop()!.replace(/\.md$/, "");
      const row = list.createEl("a", { cls: "vm-source" });
      row.createSpan({ text: `${c.n}`, cls: "vm-source-n" });
      setIcon(row.createSpan("vm-source-ico"), "file-text");
      const main = row.createSpan("vm-source-main");
      main.createSpan({ text: base, cls: "vm-source-name" });
      if (c.heading && c.heading !== "(top)") main.createSpan({ text: c.heading, cls: "vm-source-head" });
      row.title = c.path;
      row.onclick = (e) => { e.preventDefault(); this.app.workspace.openLinkText(c.path, "/", false); };
    }
  }
}

// Fuzzy picker over vault notes for "Add context".
class NotePickerModal extends FuzzySuggestModal<TFile> {
  constructor(plugin: VaultMindPlugin, private onPick: (f: TFile) => void) {
    super(plugin.app);
    this.setPlaceholder("Add a note as context…");
  }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}

function iconBtn(parent: HTMLElement, icon: string, title: string): HTMLButtonElement {
  const b = parent.createEl("button", { cls: "vm-icon-btn" });
  setIcon(b, icon);
  b.title = title;
  return b;
}

function truncate(s: string, n: number): string {
  s = s || "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function msgText(content: ChatMessage["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
  return "";
}
function msgImages(content: ChatMessage["content"]): string[] {
  if (Array.isArray(content)) return content.filter((p) => p.type === "image_url").map((p: any) => p.image_url.url);
  return [];
}
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---- friendly tool-step rendering ----
function parseArgs(s: string): any {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
function base(p: string): string {
  if (!p) return "";
  return p.split("/").pop()!.replace(/\.md$/, "");
}
function toolIcon(name: string): string {
  switch (name) {
    case "search_vault": return "search";
    case "read_note": return "file-text";
    case "get_active_note": return "file-check";
    case "traverse_links": return "git-fork";
    case "list_notes": return "folder";
    case "create_note": return "file-plus";
    case "update_note": return "file-edit";
    case "delete_file": return "trash-2";
    case "create_folder": return "folder-plus";
    case "move_file": return "folder-input";
    case "create_canvas": return "layout-dashboard";
    case "list_skills": return "sparkles";
    case "use_skill": return "wand-2";
    case "web_search": return "globe";
    case "fetch_url": return "link-2";
    case "http_request": return "webhook";
    case "deep_research": return "telescope";
    case "list_plugins": return "blocks";
    case "plugin_info": return "blocks";
    case "add_kanban_card": return "square-kanban";
    case "ask_user": return "help-circle";
    case "github_repo": case "github_issues": case "github_issue": case "github_commits": case "github_import_issues": return "github";
    case "remember": return "save";
    case "recall": return "brain";
    default: return "wrench";
  }
}
function friendlyVerb(name: string): string {
  switch (name) {
    case "search_vault": return "Searching vault";
    case "read_note": return "Reading note";
    case "get_active_note": return "Reading active note";
    case "traverse_links": return "Following links";
    case "list_notes": return "Listing notes";
    case "create_note": return "Creating note";
    case "update_note": return "Updating note";
    case "delete_file": return "Deleting";
    case "create_folder": return "Creating folder";
    case "move_file": return "Moving";
    case "create_canvas": return "Building canvas";
    case "use_skill": return "Running skill";
    default: return name;
  }
}
function friendlyTitle(name: string, argsJson: string): string {
  const a = parseArgs(argsJson);
  switch (name) {
    case "search_vault": return `Searched “${a.query ?? ""}”`;
    case "read_note": return `Read ${base(a.path)}`;
    case "get_active_note": return "Read active note";
    case "traverse_links": return `Explored links · ${base(a.path)}`;
    case "list_notes": return a.folder || a.tag ? `Listed ${a.folder || "#" + a.tag}` : "Listed notes";
    case "create_note": return `Created ${base(a.path)}`;
    case "update_note": return `Updated ${base(a.path)} (${a.mode || "append"})`;
    case "delete_file": return `Deleted ${base(a.path)}`;
    case "create_folder": return `Created folder ${base(a.path)}`;
    case "move_file": return `Moved ${base(a.from)} → ${base(a.to)}`;
    case "create_canvas": return `Canvas ${base(a.path)}`;
    case "list_skills": return "Listed skills";
    case "use_skill": return `Skill · ${a.name ?? ""}`;
    case "web_search": return `Web search “${a.query ?? ""}”`;
    case "fetch_url": return `Fetched ${(a.url || "").replace(/^https?:\/\//, "").slice(0, 40)}`;
    case "http_request": return `${(a.method || "GET").toUpperCase()} ${(a.url || "").replace(/^https?:\/\//, "").slice(0, 40)}`;
    case "deep_research": return `Researching “${(a.query || "").slice(0, 50)}”`;
    case "list_plugins": return "Listed plugins";
    case "plugin_info": return `Plugin · ${a.id ?? ""}`;
    case "add_kanban_card": return `Kanban card → ${a.list ?? ""}`;
    case "ask_user": return "Asked you";
    case "github_repo": return "GitHub repo info";
    case "github_issues": return "GitHub issues";
    case "github_issue": return `GitHub issue #${a.number ?? ""}`;
    case "github_commits": return "GitHub commits";
    case "github_import_issues": return "Imported GitHub issues";
    case "remember": return "Saved to memory";
    case "recall": return `Recalled “${a.query ?? ""}”`;
    default: return name;
  }
}
function summarizeResult(name: string, result: string): string {
  if (result.startsWith("Error")) return "error";
  if (result.startsWith("No matching")) return "0 results";
  switch (name) {
    case "search_vault": return `${result.split("\n\n---\n").length} hits`;
    case "read_note":
    case "get_active_note": return `${result.length.toLocaleString()} chars`;
    case "traverse_links": {
      const out = (result.match(/Outgoing: (.*)/)?.[1] || "").split(",").filter((s) => s.trim() && !s.includes("none")).length;
      const back = (result.match(/Backlinks: (.*)/)?.[1] || "").split(",").filter((s) => s.trim() && !s.includes("none")).length;
      return `${out + back} links`;
    }
    case "list_notes": return `${result.split("\n").filter(Boolean).length} notes`;
    case "create_note": return result.startsWith("Created") ? "created" : "skipped";
    case "update_note": return result.startsWith("Updated") ? "updated" : "skipped";
    case "delete_file": return result.startsWith("Deleted") ? "deleted" : "skipped";
    case "move_file": return result.startsWith("Moved") ? "moved" : "skipped";
    case "create_folder": return "ok";
    case "create_canvas": return result.startsWith("Created") ? "created" : "skipped";
    case "use_skill": return result.startsWith("Error") ? "not found" : "loaded";
    case "web_search": return result.startsWith("No web") ? "0 results" : `${result.split("\n\n").length} results`;
    case "fetch_url": return result.startsWith("Error") ? "failed" : `${result.length.toLocaleString()} chars`;
    case "http_request": return result.startsWith("Error") ? "failed" : `${result.length.toLocaleString()} chars`;
    case "deep_research": return result.startsWith("Error") ? "failed" : "report ready";
    case "add_kanban_card": return result.startsWith("Added") ? "added" : "skipped";
    case "list_plugins": return `${result.split("\n").filter(Boolean).length} plugins`;
    case "ask_user": return result.startsWith("User answered") ? "answered" : "dismissed";
    case "list_skills": return "done";
    default: return "done";
  }
}

function shortModel(id: string): string {
  if (!id) return "Select model";
  const parts = id.split("/");
  return parts.length > 1 ? parts[1] : id;
}

function fmtTokens(n: number): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function fmtCost(c: number): string {
  if (!c) return "free";
  if (c < 0.01) return `$${c.toFixed(5)}`;
  return `$${c.toFixed(4)}`;
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}
