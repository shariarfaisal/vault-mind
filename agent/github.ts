// GitHub connector — reads repo metadata, issues, commits via the REST API.
// Token optional for public repos (raises rate limits + private access).

import { requestUrl } from "obsidian";

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "Vault-Mind" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function parseRepo(repo: string): { owner: string; name: string } | null {
  const m = repo.trim().replace(/^https?:\/\/github\.com\//, "").match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

async function gh(path: string, token: string): Promise<any> {
  const res = await requestUrl({ url: `${API}${path}`, headers: headers(token), throw: false });
  if (res.status >= 400) {
    const msg = res.json?.message || res.text?.slice(0, 160) || res.status;
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  return res.json;
}

export async function repoInfo(repo: string, token: string): Promise<string> {
  const r = parseRepo(repo);
  if (!r) return `Invalid repo "${repo}". Use owner/name.`;
  const d = await gh(`/repos/${r.owner}/${r.name}`, token);
  return [
    `Repo: ${d.full_name}`,
    `Description: ${d.description || "(none)"}`,
    `Stars: ${d.stargazers_count} · Forks: ${d.forks_count} · Open issues: ${d.open_issues_count}`,
    `Language: ${d.language || "?"} · Default branch: ${d.default_branch}`,
    `Updated: ${d.updated_at}`,
  ].join("\n");
}

export async function listIssues(repo: string, token: string, state = "open", limit = 15): Promise<string> {
  const r = parseRepo(repo);
  if (!r) return `Invalid repo "${repo}".`;
  const items = await gh(`/repos/${r.owner}/${r.name}/issues?state=${state}&per_page=${Math.min(limit, 50)}`, token);
  const issues = (items as any[]).filter((i) => !i.pull_request);
  if (!issues.length) return `No ${state} issues.`;
  return issues
    .map((i) => `#${i.number} [${i.state}] ${i.title} — ${(i.labels || []).map((l: any) => l.name).join(", ")} (by ${i.user?.login})`)
    .join("\n");
}

export async function getIssue(repo: string, token: string, num: number): Promise<string> {
  const r = parseRepo(repo);
  if (!r) return `Invalid repo "${repo}".`;
  const i = await gh(`/repos/${r.owner}/${r.name}/issues/${num}`, token);
  return `#${i.number} ${i.title}\nState: ${i.state} · by ${i.user?.login} · ${i.created_at}\nLabels: ${(i.labels || []).map((l: any) => l.name).join(", ")}\n\n${(i.body || "(no body)").slice(0, 4000)}`;
}

export async function listCommits(repo: string, token: string, limit = 15): Promise<string> {
  const r = parseRepo(repo);
  if (!r) return `Invalid repo "${repo}".`;
  const items = await gh(`/repos/${r.owner}/${r.name}/commits?per_page=${Math.min(limit, 50)}`, token);
  return (items as any[])
    .map((c) => `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author?.name}, ${c.commit.author?.date?.slice(0, 10)})`)
    .join("\n");
}

// Returns issues as structured data for import into notes.
export async function fetchIssuesForImport(repo: string, token: string, state = "open", limit = 20): Promise<{ number: number; title: string; body: string; labels: string[]; user: string; url: string; state: string }[]> {
  const r = parseRepo(repo);
  if (!r) throw new Error(`Invalid repo "${repo}".`);
  const items = await gh(`/repos/${r.owner}/${r.name}/issues?state=${state}&per_page=${Math.min(limit, 50)}`, token);
  return (items as any[])
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body || "",
      labels: (i.labels || []).map((l: any) => l.name),
      user: i.user?.login || "",
      url: i.html_url,
      state: i.state,
    }));
}
