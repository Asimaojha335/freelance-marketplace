// Explainable matching: classic information retrieval (TF-IDF cosine similarity) plus skill overlap, rating and budget fit.
// There is no external AI service and no LLM; every score can be explained from the reasons it returns.

const STOP = new Set("a an and are as at be by for from has have in is it its of on or our that the their this to we will with you your i my me can need looking want who work working project job build make new".split(" "));

const SKILLS = [
  "javascript", "typescript", "react", "vue", "angular", "node", "express", "mongodb", "sql", "postgres", "python", "django", "flask", "java", "spring", "kotlin", "swift", "flutter", "android", "ios",
  "html", "css", "tailwind", "figma", "photoshop", "illustrator", "ui", "ux", "branding", "logo", "seo", "marketing", "copywriting", "content", "writing", "editing", "video", "animation",
  "wordpress", "shopify", "php", "laravel", "aws", "docker", "devops", "testing", "qa", "data", "analytics", "excel", "machine learning", "ai", "translation", "voiceover", "social media",
];

const stem = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
function tokens(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ").split(/\s+/).map((w) => w.replace(/^[.]+|[.]+$/g, "")).filter((w) => w && !STOP.has(w) && w.length > 1).map(stem);
}

const ALIASES = [[/\bnode\.?js\b/g, "node"], [/\breact\.?js\b/g, "react"], [/\bvue\.?js\b/g, "vue"], [/\bexpress\.?js\b/g, "express"], [/\bnext\.?js\b/g, "react"], [/\bui\s*\/\s*ux\b/g, "ui ux"], [/\bml\b/g, "machine learning"]];

function extractSkills(text) {
  let lower = String(text || "").toLowerCase();
  ALIASES.forEach(([re, to]) => { lower = lower.replace(re, to); });
  const t = ` ${lower.replace(/[^a-z0-9+#\s]/g, " ")} `;
  const found = SKILLS.filter((s) => new RegExp(`[\\s]${s.replace(/[+#.]/g, "\\$&")}s?[\\s]`).test(t));
  return [...new Set(found)].slice(0, 8);
}

function tf(tok) {
  const m = new Map();
  tok.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
  return m;
}

// documents: [{ id, tokens }], query tokens; returns Map(id -> cosine similarity 0..1)
function cosineScores(queryTokens, documents) {
  const N = documents.length + 1;
  const df = new Map();
  [queryTokens, ...documents.map((d) => d.tokens)].forEach((tok) => new Set(tok).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const idf = (t) => Math.log(1 + N / (df.get(t) || 1));
  const vec = (tok) => {
    const v = new Map();
    tf(tok).forEach((c, t) => v.set(t, (1 + Math.log(c)) * idf(t)));
    return v;
  };
  const norm = (v) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
  const q = vec(queryTokens);
  const qn = norm(q);
  const out = new Map();
  for (const d of documents) {
    const v = vec(d.tokens);
    let dot = 0;
    q.forEach((x, t) => { if (v.has(t)) dot += x * v.get(t); });
    out.set(d.id, dot / (qn * norm(v)));
  }
  return out;
}

const skillSet = (list) => new Set((list || []).map((s) => String(s).toLowerCase()));
function overlap(required, have) {
  const r = skillSet(required);
  const h = skillSet(have);
  if (!r.size) return { ratio: 0, matched: [] };
  const matched = [...r].filter((s) => h.has(s));
  return { ratio: matched.length / r.size, matched };
}

// Rank freelancers for a job. freelancers: [{ id, headline, bio, skills, rate, rating, reviews, jobsDone }]
function rankFreelancers(job, freelancers) {
  const docs = freelancers.map((f) => ({ id: f.id, tokens: [...tokens(`${f.headline} ${f.bio}`), ...f.skills.flatMap((s) => [...tokens(s), ...tokens(s), ...tokens(s)])] }));
  const cos = cosineScores([...tokens(`${job.title} ${job.description}`), ...job.skills.flatMap((s) => [...tokens(s), ...tokens(s), ...tokens(s)])], docs);
  return freelancers.map((f) => {
    const sk = overlap(job.skills, f.skills);
    const ratingNorm = f.reviews ? f.rating / 5 : 0.6;
    const perHourBudget = job.budget / 100 / 40;
    const priceFit = f.rate ? Math.max(0, Math.min(1, perHourBudget / f.rate)) : 0.5;
    const score = 0.5 * Math.min(1, cos.get(f.id) * 1.6) + 0.3 * sk.ratio + 0.12 * ratingNorm + 0.08 * priceFit;
    const reasons = [];
    if (sk.matched.length) reasons.push(`Has ${sk.matched.length} of ${job.skills.length} required skills (${sk.matched.join(", ")})`);
    if (cos.get(f.id) > 0.15) reasons.push("Profile text is similar to the job description");
    if (f.reviews >= 1 && f.rating >= 4.5) reasons.push(`Rated ${f.rating.toFixed(1)} from ${f.reviews} review${f.reviews === 1 ? "" : "s"}`);
    if (f.jobsDone >= 3) reasons.push(`${f.jobsDone} projects completed`);
    if (priceFit >= 0.8) reasons.push("Hourly rate fits the budget");
    return { id: f.id, score: Math.round(Math.min(1, score) * 100), reasons, matchedSkills: sk.matched };
  }).sort((a, b) => b.score - a.score);
}

// Rank jobs for a freelancer profile. jobs: [{ id, title, description, skills, budget }]
function rankJobs(profile, jobs) {
  const docs = jobs.map((j) => ({ id: j.id, tokens: [...tokens(`${j.title} ${j.description}`), ...j.skills.flatMap((s) => [...tokens(s), ...tokens(s), ...tokens(s)])] }));
  const cos = cosineScores([...tokens(`${profile.headline} ${profile.bio}`), ...profile.skills.flatMap((s) => [...tokens(s), ...tokens(s), ...tokens(s)])], docs);
  return jobs.map((j) => {
    const sk = overlap(j.skills, profile.skills);
    const score = 0.55 * Math.min(1, cos.get(j.id) * 1.6) + 0.45 * sk.ratio;
    const reasons = [];
    if (sk.matched.length) reasons.push(`You have ${sk.matched.length} of ${j.skills.length} skills asked for (${sk.matched.join(", ")})`);
    if (cos.get(j.id) > 0.15) reasons.push("Similar to what your profile describes");
    return { id: j.id, score: Math.round(Math.min(1, score) * 100), reasons };
  }).sort((a, b) => b.score - a.score);
}

// Typical budget for similar jobs: median of completed/awarded budgets sharing at least one skill.
function budgetHint(job, others) {
  const pool = others.filter((o) => overlap(job.skills, o.skills).matched.length > 0).map((o) => o.budget).sort((a, b) => a - b);
  if (pool.length < 2) return null;
  const q = (p) => pool[Math.min(pool.length - 1, Math.floor(p * (pool.length - 1)))];
  return { low: q(0.25), median: q(0.5), high: q(0.75), sample: pool.length };
}

module.exports = { tokens, extractSkills, cosineScores, rankFreelancers, rankJobs, budgetHint, overlap };
