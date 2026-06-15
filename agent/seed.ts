// Seeds a connected "InsideSuccess.TV" demo substrate: MOCs + cross-linked notes
// across Sales, Marketing, Customers, Hiring, Product, Decisions. Lets the agent
// demonstrate cross-domain reasoning over a real knowledge graph.

import { App, normalizePath } from "obsidian";

const ROOT = "InsideSuccess";

interface Seed { path: string; content: string; }

function fm(type: string, tags: string[]): string {
  return `---\ntype: ${type}\ntags: [${tags.join(", ")}]\n---\n`;
}

const SEEDS: Seed[] = [
  // ---------- MOCs ----------
  {
    path: `${ROOT}/00 MOCs/Company MOC.md`,
    content:
      fm("moc", ["moc", "company"]) +
      `# Company MOC — InsideSuccess.TV\n\nThe "Netflix of Business TV". This is the top of the knowledge graph.\n\n## Domains\n- [[Sales MOC]]\n- [[Marketing MOC]]\n- [[Product MOC]]\n- [[People MOC]]\n- [[Decisions Log]]\n\n## Strategy\nOur moat is a [[Connected Knowledge Substrate]] — every concept linked, so each AI tool we add gets smarter from the rest of the system.\n`,
  },
  {
    path: `${ROOT}/00 MOCs/Sales MOC.md`,
    content:
      fm("moc", ["moc", "sales"]) +
      `# Sales MOC\n\nUp: [[Company MOC]]\n\n## Calls\n- [[Sales Call - Acme Corp]]\n- [[Sales Call - Bravo Media]]\n\n## Patterns\n- [[Customer Pattern - Onboarding Friction]]\n- [[Customer Pattern - Champion Turnover]]\n`,
  },
  {
    path: `${ROOT}/00 MOCs/Marketing MOC.md`,
    content:
      fm("moc", ["moc", "marketing"]) +
      `# Marketing MOC\n\nUp: [[Company MOC]]\n\n- [[Marketing Strategy - Q3 Positioning]]\n- [[Content Pillar - Founder Stories]]\n- [[ICP - Mid-Market Operators]]\n`,
  },
  {
    path: `${ROOT}/00 MOCs/Product MOC.md`,
    content:
      fm("moc", ["moc", "product"]) +
      `# Product MOC\n\nUp: [[Company MOC]]\n\n- [[Feature - Personalized Playlists]]\n- [[Feature - Watch-Together Rooms]]\n- [[Customer Pattern - Onboarding Friction]]\n`,
  },
  {
    path: `${ROOT}/00 MOCs/People MOC.md`,
    content:
      fm("moc", ["moc", "people"]) +
      `# People MOC\n\nUp: [[Company MOC]]\n\n- [[Hiring Philosophy]]\n- [[Role - Knowledge Systems Engineer]]\n- [[Culture - High Turnover Thrown Into Fire]]\n`,
  },

  // ---------- Sales ----------
  {
    path: `${ROOT}/Sales/Sales Call - Acme Corp.md`,
    content:
      fm("transcript", ["sales", "transcript"]) +
      `# Sales Call — Acme Corp\n\nUp: [[Sales MOC]]\n\n**Summary:** Acme's ops lead loved the content but stalled during setup. Team couldn't get past inviting their org.\n\n> "The videos are great, but it took us a week to figure out how to roll it out internally."\n\nThis is the same [[Customer Pattern - Onboarding Friction]] we keep hearing. Their champion also hinted they might leave — see [[Customer Pattern - Champion Turnover]].\n\nRelevant product idea: [[Feature - Watch-Together Rooms]] would have shortcut their internal rollout.\n`,
  },
  {
    path: `${ROOT}/Sales/Sales Call - Bravo Media.md`,
    content:
      fm("transcript", ["sales", "transcript"]) +
      `# Sales Call — Bravo Media\n\nUp: [[Sales MOC]]\n\n**Summary:** Bravo bought fast because a founder-story episode resonated. They map exactly to [[ICP - Mid-Market Operators]].\n\n> "We signed because the founder interviews felt like they were made for operators like us."\n\nThis validates [[Content Pillar - Founder Stories]] and [[Marketing Strategy - Q3 Positioning]].\n`,
  },
  {
    path: `${ROOT}/Sales/Customer Pattern - Onboarding Friction.md`,
    content:
      fm("pattern", ["sales", "customers", "pattern"]) +
      `# Customer Pattern — Onboarding Friction\n\nUp: [[Sales MOC]]\n\nRecurring across [[Sales Call - Acme Corp]] and others: customers love the content but struggle to roll it out to their org.\n\n**Implications**\n- Product: prioritize [[Feature - Watch-Together Rooms]] and guided rollout.\n- Marketing: [[ICP - Mid-Market Operators]] need rollout proof, not just content quality.\n- Hiring: we need people who reduce friction fast — see [[Hiring Philosophy]].\n`,
  },
  {
    path: `${ROOT}/Sales/Customer Pattern - Champion Turnover.md`,
    content:
      fm("pattern", ["sales", "customers", "pattern"]) +
      `# Customer Pattern — Champion Turnover\n\nUp: [[Sales MOC]]\n\nDeals wobble when our internal champion changes jobs (seen in [[Sales Call - Acme Corp]]).\n\n**Implications**\n- Product: multi-stakeholder value (not one champion).\n- People: this mirrors our own [[Culture - High Turnover Thrown Into Fire]] — turnover is a fact of life; design for it.\n`,
  },

  // ---------- Marketing ----------
  {
    path: `${ROOT}/Marketing/Marketing Strategy - Q3 Positioning.md`,
    content:
      fm("strategy", ["marketing", "strategy"]) +
      `# Marketing Strategy — Q3 Positioning\n\nUp: [[Marketing MOC]]\n\nPosition InsideSuccess as the operator's business TV. Lead with [[Content Pillar - Founder Stories]], target [[ICP - Mid-Market Operators]].\n\nEvidence: [[Sales Call - Bravo Media]] closed on exactly this angle. Counter-signal: [[Customer Pattern - Onboarding Friction]] means messaging must include rollout ease.\n`,
  },
  {
    path: `${ROOT}/Marketing/Content Pillar - Founder Stories.md`,
    content:
      fm("content", ["marketing", "content"]) +
      `# Content Pillar — Founder Stories\n\nUp: [[Marketing MOC]]\n\nLong-form founder interviews. Resonates with operators (see [[Sales Call - Bravo Media]]). Feeds [[Marketing Strategy - Q3 Positioning]].\n`,
  },
  {
    path: `${ROOT}/Marketing/ICP - Mid-Market Operators.md`,
    content:
      fm("icp", ["marketing", "icp"]) +
      `# ICP — Mid-Market Operators\n\nUp: [[Marketing MOC]]\n\nOps/COO-type buyers at 50–500 person companies. Value practical, peer-proven content. Pain: internal rollout ([[Customer Pattern - Onboarding Friction]]).\n`,
  },

  // ---------- Product ----------
  {
    path: `${ROOT}/Product/Feature - Personalized Playlists.md`,
    content:
      fm("feature", ["product", "feature"]) +
      `# Feature — Personalized Playlists\n\nUp: [[Product MOC]]\n\nRecommend episodes by role/goal. Supports [[Marketing Strategy - Q3 Positioning]] by making "made for operators" literal.\n`,
  },
  {
    path: `${ROOT}/Product/Feature - Watch-Together Rooms.md`,
    content:
      fm("feature", ["product", "feature"]) +
      `# Feature — Watch-Together Rooms\n\nUp: [[Product MOC]]\n\nTeams watch + discuss together. Directly attacks [[Customer Pattern - Onboarding Friction]] by making rollout a shared event. Raised in [[Sales Call - Acme Corp]].\n`,
  },

  // ---------- People ----------
  {
    path: `${ROOT}/People/Hiring Philosophy.md`,
    content:
      fm("philosophy", ["people", "hiring"]) +
      `# Hiring Philosophy\n\nUp: [[People MOC]]\n\nHire obsessed builders who already do the work unpaid. Bias to people who reduce friction fast — connects to [[Customer Pattern - Onboarding Friction]]. Accept [[Culture - High Turnover Thrown Into Fire]].\n\nApplies to [[Role - Knowledge Systems Engineer]].\n`,
  },
  {
    path: `${ROOT}/People/Role - Knowledge Systems Engineer.md`,
    content:
      fm("role", ["people", "hiring", "role"]) +
      `# Role — Knowledge Systems Engineer\n\nUp: [[People MOC]]\n\nArchitect the [[Connected Knowledge Substrate]]. Connect tools (Slack, GitHub, Monday, Claude) into one graph. Embodies [[Hiring Philosophy]].\n`,
  },
  {
    path: `${ROOT}/People/Culture - High Turnover Thrown Into Fire.md`,
    content:
      fm("culture", ["people", "culture"]) +
      `# Culture — High Turnover, Thrown Into Fire\n\nUp: [[People MOC]]\n\nIntense, high-expectation. Turnover is high by design. Mirrors [[Customer Pattern - Champion Turnover]] — build systems that survive people leaving. The substrate is that system.\n`,
  },

  // ---------- Substrate + decisions ----------
  {
    path: `${ROOT}/Connected Knowledge Substrate.md`,
    content:
      fm("concept", ["substrate", "strategy"]) +
      `# Connected Knowledge Substrate\n\nUp: [[Company MOC]]\n\nOne linked layer where [[Sales MOC]], [[Marketing MOC]], [[Product MOC]] and [[People MOC]] connect. AI tools are nodes that read and write here. Built by the [[Role - Knowledge Systems Engineer]].\n\nThe moat: competitors can buy the same models, not this graph.\n`,
  },
  {
    path: `${ROOT}/Decisions Log.md`,
    content:
      fm("log", ["decisions"]) +
      `# Decisions Log\n\nUp: [[Company MOC]]\n\n- **Prioritize [[Feature - Watch-Together Rooms]]** — driven by [[Customer Pattern - Onboarding Friction]] across sales calls.\n- **Lead Q3 with founder stories** — [[Marketing Strategy - Q3 Positioning]], validated by [[Sales Call - Bravo Media]].\n- **Hire a [[Role - Knowledge Systems Engineer]]** — to build the [[Connected Knowledge Substrate]].\n`,
  },
];

export async function seedDemoVault(app: App): Promise<number> {
  // ensure folders
  const folders = new Set<string>();
  for (const s of SEEDS) {
    const dir = s.path.split("/").slice(0, -1).join("/");
    folders.add(dir);
  }
  // create nested folders in order
  for (const dir of [...folders].sort()) {
    const parts = dir.split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur).catch(() => {});
    }
  }
  let n = 0;
  for (const s of SEEDS) {
    const path = normalizePath(s.path);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing) continue; // don't clobber
    await app.vault.create(path, s.content);
    n++;
  }
  return n;
}
