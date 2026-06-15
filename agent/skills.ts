// Skills: reusable instruction recipes the agent can invoke as tools.
// A skill is a markdown note in the skills folder with frontmatter { name, description }
// and a body of instructions. The agent lists skills and pulls one in to follow it.

import { App, TFile, normalizePath } from "obsidian";

export interface SkillDef {
  name: string;
  description: string;
  body: string;
  path: string;
}

export class SkillManager {
  constructor(private app: App, private folder: string) {}

  setFolder(folder: string) {
    this.folder = folder;
  }

  private bodyWithoutFrontmatter(content: string): string {
    const m = content.match(/^---\n[\s\S]*?\n---\n?/);
    return m ? content.slice(m[0].length).trim() : content.trim();
  }

  list(): SkillDef[] {
    const out: SkillDef[] = [];
    const folder = normalizePath(this.folder);
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.parent?.path !== folder && !f.path.startsWith(folder + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      out.push({
        name: String(fm.name || f.basename),
        description: String(fm.description || ""),
        body: "", // lazy; filled by get()
        path: f.path,
      });
    }
    return out;
  }

  async get(name: string): Promise<SkillDef | null> {
    const folder = normalizePath(this.folder);
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.parent?.path !== folder && !f.path.startsWith(folder + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      const skillName = String(fm.name || f.basename);
      if (skillName.toLowerCase() === name.toLowerCase() || f.basename.toLowerCase() === name.toLowerCase()) {
        const content = await this.app.vault.cachedRead(f);
        return {
          name: skillName,
          description: String(fm.description || ""),
          body: this.bodyWithoutFrontmatter(content),
          path: f.path,
        };
      }
    }
    return null;
  }

  // Create a sample skill so users see the format.
  async createSample(): Promise<string> {
    const folder = normalizePath(this.folder);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const path = `${folder}/Daily Note Summary.md`;
    if (this.app.vault.getAbstractFileByPath(path)) return path;
    const content = `---
name: Daily Note Summary
description: Summarize recent notes into a structured daily digest with action items.
---

When invoked, do the following:

1. Use \`search_vault\` and \`list_notes\` to gather notes the user worked on recently.
2. Read the most relevant ones with \`read_note\`.
3. Produce a digest with these sections:
   - **Highlights** — 3-5 bullet points of what matters, each citing the source [[note]].
   - **Open threads** — unresolved questions or TODOs found across notes.
   - **Suggested next actions** — concrete next steps.
4. Keep it terse. Cite every claim with [[wikilinks]].
`;
    await this.app.vault.create(path, content);
    return path;
  }
}
