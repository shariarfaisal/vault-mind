// Hybrid retriever (PRD §4.3): fuses three channels with Reciprocal Rank Fusion (RRF):
//   1. BM25 keyword (MiniSearch)
//   2. Dense vectors (local embeddings via transformers.js) — optional, lazy
//   3. Graph traversal (1-hop link/backlink expansion of top hits)
// Note = entity, heading-section = chunk, wikilink = relation.

import { App, TFile, Notice } from "obsidian";
import MiniSearch from "minisearch";
import { RetrievedChunk } from "../types";

interface Chunk {
  id: string;
  path: string;
  heading: string;
  text: string;
}

const RRF_K = 60; // standard RRF constant

export class Retriever {
  private app: App;
  private index: MiniSearch<Chunk> | null = null;
  private chunks: Map<string, Chunk> = new Map();
  private order: string[] = []; // chunk ids in insertion order
  private vectors: Map<string, Float32Array> = new Map();
  private built = false;

  // semantic config
  useSemantic = false;
  embedModel = "Xenova/multilingual-e5-small";
  private embedder: any = null;
  private embedderPromise: Promise<any> | null = null;

  constructor(app: App) {
    this.app = app;
  }

  isBuilt(): boolean {
    return this.built;
  }

  // Mark the index stale so the next search rebuilds (call on vault changes).
  markDirty() {
    this.built = false;
  }

  configure(useSemantic: boolean, embedModel: string) {
    if (this.embedModel !== embedModel) {
      this.embedder = null;
      this.embedderPromise = null;
      this.vectors.clear();
    }
    this.useSemantic = useSemantic;
    this.embedModel = embedModel;
  }

  private chunkNote(path: string, body: string): Chunk[] {
    const lines = body.split("\n");
    const out: Chunk[] = [];
    let heading = "(top)";
    let buf: string[] = [];
    let part = 0;
    const flush = () => {
      const text = buf.join("\n").trim();
      if (text.length > 0) out.push({ id: `${path}::${part++}`, path, heading, text });
      buf = [];
    };
    for (const line of lines) {
      const m = line.match(/^#{1,6}\s+(.*)/);
      if (m) {
        flush();
        heading = m[1].trim();
      } else buf.push(line);
    }
    flush();
    return out;
  }

  private async getEmbedder(): Promise<any> {
    if (this.embedder) return this.embedder;
    if (!this.embedderPromise) {
      this.embedderPromise = (async () => {
        const t = await import("@xenova/transformers");
        t.env.allowLocalModels = false; // pull weights from HF hub
        const pipe = await t.pipeline("feature-extraction", this.embedModel);
        this.embedder = pipe;
        return pipe;
      })();
    }
    return this.embedderPromise;
  }

  private async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getEmbedder();
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data as Float32Array);
  }

  async build(onProgress?: (done: number, total: number) => void): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    this.chunks.clear();
    this.order = [];
    this.vectors.clear();
    const all: Chunk[] = [];
    for (const f of files) {
      const body = await this.app.vault.cachedRead(f);
      for (const c of this.chunkNote(f.path, body)) {
        this.chunks.set(c.id, c);
        this.order.push(c.id);
        all.push(c);
      }
    }
    this.index = new MiniSearch<Chunk>({
      fields: ["text", "heading", "path"],
      storeFields: ["path", "heading"],
      searchOptions: { boost: { heading: 2, text: 1 }, fuzzy: 0.2, prefix: true },
    });
    this.index.addAll(all);

    if (this.useSemantic) {
      let done = 0;
      for (const c of all) {
        try {
          this.vectors.set(c.id, await this.embed("passage: " + c.text.slice(0, 1000)));
        } catch (e) {
          new Notice(`Vault Mind: embedding failed — ${(e as any)?.message || e}`);
          this.useSemantic = false;
          break;
        }
        done++;
        if (onProgress && done % 5 === 0) onProgress(done, all.length);
      }
    }

    this.built = true;
    return all.length;
  }

  // BM25 ranked chunk ids
  private bm25(query: string, limit: number): string[] {
    if (!this.index) return [];
    return this.index.search(query).slice(0, limit).map((r) => r.id as string);
  }

  // dense cosine ranked chunk ids
  private async vectorRank(query: string, limit: number): Promise<string[]> {
    if (!this.useSemantic || !this.vectors.size) return [];
    let qv: Float32Array;
    try {
      qv = await this.embed("query: " + query);
    } catch {
      return [];
    }
    const scored: { id: string; s: number }[] = [];
    for (const [id, v] of this.vectors) scored.push({ id, s: cosine(qv, v) });
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.id);
  }

  // graph expansion: chunks of notes linked to/from the seed notes
  private graphRank(seedChunkIds: string[], limit: number): string[] {
    const resolved = this.app.metadataCache.resolvedLinks;
    const seedNotes = new Set(seedChunkIds.map((id) => this.chunks.get(id)?.path).filter(Boolean) as string[]);
    const neighborNotes = new Set<string>();
    for (const note of seedNotes) {
      // outgoing
      for (const tgt of Object.keys(resolved[note] || {})) neighborNotes.add(tgt);
      // backlinks
      for (const src in resolved) if (resolved[src][note]) neighborNotes.add(src);
    }
    for (const s of seedNotes) neighborNotes.delete(s);
    const out: string[] = [];
    for (const id of this.order) {
      const c = this.chunks.get(id);
      if (c && neighborNotes.has(c.path)) {
        out.push(id);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // Reciprocal Rank Fusion over the channels.
  async search(query: string, k: number): Promise<RetrievedChunk[]> {
    if (!this.index) return [];
    const pool = Math.max(k * 4, 20);
    const bm = this.bm25(query, pool);
    const vec = await this.vectorRank(query, pool);
    const seed = [...new Set([...bm.slice(0, 5), ...vec.slice(0, 5)])];
    const graph = this.graphRank(seed, pool);

    const score = new Map<string, number>();
    const fuse = (list: string[], weight: number) => {
      list.forEach((id, rank) => {
        score.set(id, (score.get(id) || 0) + weight / (RRF_K + rank + 1));
      });
    };
    fuse(bm, 1.0);
    fuse(vec, 1.0);
    fuse(graph, 0.5); // graph as supporting signal

    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return ranked.map(([id], i) => {
      const c = this.chunks.get(id)!;
      return { n: i + 1, path: c.path, heading: c.heading, text: c.text.slice(0, 1200), score: score.get(id)! };
    });
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  // vectors are L2-normalized => dot product == cosine
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
