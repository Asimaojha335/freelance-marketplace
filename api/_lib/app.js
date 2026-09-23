const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { createApp, bad, forbidden, notFound, conflict, oid, clean, str, num, oneOf, created } = require("./http");
const { addAuthRoutes } = require("./authRoutes");
const M = require("./match");

const FEE_RATE = 0.05;
const DAY = 86400000;
const HELD = ["funded", "submitted", "disputed"];
const DONE = ["released", "refunded", "resolved"];
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const rid = () => crypto.randomBytes(5).toString("hex");
const asId = (v) => new ObjectId(String(v));

const app = createApp({
  app: "freelance-marketplace",
  dbName: "freelance_marketplace",
  setup: async (db) => {
    await db.collection("profiles").createIndex({ userId: 1 }, { unique: true });
    await db.collection("proposals").createIndex({ jobId: 1, freelancerId: 1 }, { unique: true });
    await db.collection("reviews").createIndex({ contractId: 1, fromId: 1 }, { unique: true });
    await db.collection("transactions").createIndex({ userId: 1, at: -1 });
    await seed(db);
  },
});
addAuthRoutes(app, { roles: ["client", "freelancer"], extra: (b) => ({ role: b.role === "freelancer" ? "freelancer" : "client", balance: 0 }) });

const users = (db) => db.collection("users");
const need = (user, role) => {
  if (user.role !== role) throw forbidden(role === "client" ? "Only clients can do that." : "Only freelancers can do that.");
};

async function txn(db, userId, type, amount, note, contractId) {
  await db.collection("transactions").insertOne({ userId: String(userId), type, amount, note, contractId: contractId ? String(contractId) : null, at: new Date() });
}

// Conditional debit so a balance can never go negative, even with concurrent requests.
async function debit(db, userId, amount) {
  const r = await users(db).updateOne({ _id: asId(userId), balance: { $gte: amount } }, { $inc: { balance: -amount } });
  return r.modifiedCount === 1;
}
const credit = (db, userId, amount) => users(db).updateOne({ _id: asId(userId) }, { $inc: { balance: amount } });

/* ---------- demo content shared by every visitor ---------- */
async function seed(db) {
  if (await db.collection("meta").findOne({ _id: "seeded" })) return;
  await db.collection("meta").updateOne({ _id: "seeded" }, { $set: { at: new Date() } }, { upsert: true });
  const now = new Date();
  const people = [
    ["Aarav Menon", "Full-stack developer (React, Node, MongoDB)", "I build SaaS dashboards and REST APIs with React, Node.js and MongoDB. Clean code, tests and clear communication.", ["react", "node", "mongodb", "javascript", "html", "css"], 1800, 4.9, 31, 12],
    ["Diya Kapoor", "UI/UX designer for web and mobile apps", "Product designer who turns messy ideas into clear Figma prototypes, design systems and landing pages.", ["figma", "ui", "ux", "branding", "css"], 1500, 4.8, 24, 9],
    ["Rohan Bhatt", "Python and data analysis", "Data analyst and Python developer: dashboards, Excel automation, SQL reporting and machine learning experiments.", ["python", "sql", "data", "excel", "analytics", "machine learning"], 1300, 4.6, 15, 6],
    ["Ishita Rao", "SEO and content marketing writer", "I write search-optimised blog posts, landing page copy and newsletters that convert.", ["seo", "copywriting", "content", "writing", "marketing"], 900, 4.7, 40, 18],
    ["Karan Singh", "WordPress and Shopify developer", "I set up fast, good-looking online stores and business sites on WordPress and Shopify, including custom themes.", ["wordpress", "shopify", "php", "html", "css", "javascript"], 1100, 4.5, 19, 8],
    ["Neha Verma", "Mobile developer (Flutter and Android)", "Cross-platform mobile apps with Flutter, Firebase and clean architecture. Published 6 apps on Google Play.", ["flutter", "android", "kotlin", "java"], 1600, 4.8, 12, 5],
    ["Vikram Joshi", "Video editor and motion designer", "Short-form video, YouTube edits, explainers and animated logos with a fast turnaround.", ["video", "editing", "animation", "photoshop", "illustrator"], 1000, 4.4, 10, 4],
    ["Ananya Das", "Junior React developer", "Recent graduate building responsive React front-ends. Eager to learn, reliable and affordable.", ["react", "javascript", "html", "css", "tailwind"], 500, 0, 0, 0],
  ];
  for (const [name, headline, bio, skills, rate, rating, reviews, jobsDone] of people) {
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}@demo.talentbridge.example`;
    const { insertedId } = await users(db).insertOne({ name, email, role: "freelancer", balance: 0, demo: true, createdAt: now });
    await db.collection("profiles").insertOne({ userId: String(insertedId), headline, bio, skills, rate, ratingSum: Math.round(rating * reviews * 10) / 10, reviews, jobsDone, createdAt: now });
  }
  const clients = ["Northwind Studio", "Bloom Bakery", "PixelPath Games"];
  const cids = [];
  for (const name of clients) cids.push(String((await users(db).insertOne({ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@demo.talentbridge.example`, role: "client", balance: 0, demo: true, createdAt: now })).insertedId));
  const jobs = [
    [0, "Build an admin dashboard in React with a Node API", "We need an internal admin dashboard: user table, charts, filters and a REST API using Node.js and MongoDB. Authentication and role permissions required.", 60000, 21],
    [1, "Design a landing page and simple brand kit for our bakery", "Bloom Bakery is launching online orders. We need a friendly landing page design in Figma, a logo refresh, colour palette and social media templates.", 25000, 14],
    [0, "Product page SEO and 8 blog articles", "Write eight search-optimised articles for our SaaS blog and improve on-page SEO for our main product pages. Keyword research included.", 18000, 30],
    [2, "Flutter mobile prototype for a puzzle game", "Create a polished Android and iOS prototype of a puzzle game using Flutter with levels, scoring and animations. Firebase for leaderboards.", 90000, 35],
    [1, "Migrate our store to Shopify and customise the theme", "Move about 120 products from WordPress to Shopify, set up payments and shipping, and customise the theme to match our brand.", 40000, 18],
  ];
  await db.collection("jobs").insertMany(jobs.map(([c, title, description, budget, days]) => ({
    clientId: cids[c], clientName: clients[c], title, description, skills: M.extractSkills(`${title} ${description}`), budget: toPaise(budget), deadline: new Date(now.getTime() + days * DAY), status: "open", createdAt: new Date(now.getTime() - Math.random() * 5 * DAY),
  })));
}

/* ---------- profiles and freelancers ---------- */
const profileView = (u, p) => ({
  id: String(u._id), name: u.name, headline: p.headline, bio: p.bio, skills: p.skills, rate: p.rate,
  rating: p.reviews ? Math.round((p.ratingSum / p.reviews) * 10) / 10 : 0, reviews: p.reviews, jobsDone: p.jobsDone,
});

async function freelancerViews(db, filter = {}) {
  const profiles = await db.collection("profiles").find(filter).toArray();
  const us = new Map((await users(db).find({ _id: { $in: profiles.map((p) => asId(p.userId)) } }).toArray()).map((u) => [String(u._id), u]));
  return profiles.filter((p) => us.has(p.userId)).map((p) => profileView(us.get(p.userId), p));
}

function profileFields(b) {
  const skills = (Array.isArray(b.skills) ? b.skills : String(b.skills || "").split(",")).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!skills.length) throw bad("Add at least one skill.");
  return {
    headline: str(b.headline, { min: 5, max: 90, label: "Headline" }), bio: str(b.bio, { min: 20, max: 1200, label: "About you" }),
    skills: [...new Set(skills)].slice(0, 15), rate: num(b.rate, { min: 100, max: 100000, int: true, label: "Hourly rate" }),
  };
}

app.get("/profile", { auth: true }, async ({ db, user }) => {
  need(user, "freelancer");
  const p = await db.collection("profiles").findOne({ userId: user.id });
  return p ? profileView({ _id: user.id, name: user.name }, p) : null;
});

app.put("/profile", { auth: true }, async ({ db, user, body }) => {
  need(user, "freelancer");
  const fields = profileFields(body);
  await db.collection("profiles").updateOne({ userId: user.id }, { $set: fields, $setOnInsert: { userId: user.id, ratingSum: 0, reviews: 0, jobsDone: 0, createdAt: new Date() } }, { upsert: true });
  return profileView({ _id: user.id, name: user.name }, await db.collection("profiles").findOne({ userId: user.id }));
});

app.get("/freelancers", { auth: true }, async ({ db, query }) => {
  let list = await freelancerViews(db);
  const q = String(query.q || "").trim();
  if (query.skill) list = list.filter((f) => f.skills.includes(String(query.skill).toLowerCase()));
  if (q) {
    const scores = M.cosineScores(M.tokens(q), list.map((f) => ({ id: f.id, tokens: [...M.tokens(`${f.headline} ${f.bio}`), ...f.skills.flatMap((s) => M.tokens(s))] })));
    list = list.map((f) => ({ ...f, relevance: Math.round(scores.get(f.id) * 100) })).filter((f) => f.relevance > 5).sort((a, b) => b.relevance - a.relevance);
  } else list.sort((a, b) => b.rating - a.rating || b.jobsDone - a.jobsDone);
  return list.slice(0, 40);
});

app.get("/freelancers/:id", { auth: true }, async ({ db, params }) => {
  const list = await freelancerViews(db, { userId: String(params.id) });
  if (!list.length) throw notFound("Freelancer not found.");
  const reviews = await db.collection("reviews").find({ toId: String(params.id) }).sort({ at: -1 }).limit(10).toArray();
  return { ...list[0], recentReviews: reviews.map(clean) };
});

/* ---------- jobs ---------- */
function jobFields(b) {
  const skills = Array.isArray(b.skills) ? b.skills : String(b.skills || "").split(",");
  const description = str(b.description, { min: 30, max: 3000, label: "Description" });
  const title = str(b.title, { min: 5, max: 100, label: "Title" });
  const cleaned = [...new Set(skills.map((s) => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
  const deadline = new Date(b.deadline);
  if (Number.isNaN(deadline.getTime()) || deadline < new Date()) throw bad("Pick a deadline in the future.");
  return { title, description, skills: cleaned.length ? cleaned : M.extractSkills(`${title} ${description}`), budget: toPaise(num(b.budget, { min: 500, max: 1000000, label: "Budget" })), deadline };
}

app.post("/skills/extract", { auth: true }, async ({ body }) => ({ skills: M.extractSkills(`${body.title || ""} ${body.description || ""}`) }));

app.post("/jobs", { auth: true }, async ({ db, user, body }) => {
  need(user, "client");
  const doc = { clientId: user.id, clientName: user.name, ...jobFields(body), status: "open", createdAt: new Date() };
  const { insertedId } = await db.collection("jobs").insertOne(doc);
  return created(clean({ _id: insertedId, ...doc }));
});

const jobView = (j, extra = {}) => ({ ...clean(j), ...extra });

app.get("/jobs", { auth: true }, async ({ db, user, query }) => {
  const filter = user.role === "client" ? { clientId: user.id } : { status: "open" };
  if (query.skill) filter.skills = String(query.skill).toLowerCase();
  if (query.min) filter.budget = { ...(filter.budget || {}), $gte: toPaise(query.min) };
  let jobs = await db.collection("jobs").find(filter).sort({ createdAt: -1 }).limit(100).toArray();
  const q = String(query.q || "").trim();
  if (q) {
    const scores = M.cosineScores(M.tokens(q), jobs.map((j) => ({ id: String(j._id), tokens: [...M.tokens(`${j.title} ${j.description}`), ...j.skills.flatMap((s) => M.tokens(s))] })));
    jobs = jobs.filter((j) => scores.get(String(j._id)) > 0.05).sort((a, b) => scores.get(String(b._id)) - scores.get(String(a._id)));
  }
  const ids = jobs.map((j) => String(j._id));
  const counts = new Map((await db.collection("proposals").aggregate([{ $match: { jobId: { $in: ids } } }, { $group: { _id: "$jobId", n: { $sum: 1 } } }]).toArray()).map((c) => [c._id, c.n]));
  const mine = user.role === "freelancer" ? new Map((await db.collection("proposals").find({ freelancerId: user.id, jobId: { $in: ids } }).toArray()).map((p) => [p.jobId, p.status])) : new Map();
  return jobs.map((j) => jobView(j, { proposals: counts.get(String(j._id)) || 0, myProposal: mine.get(String(j._id)) || null }));
});

app.get("/jobs/recommended", { auth: true }, async ({ db, user }) => {
  need(user, "freelancer");
  const profile = await db.collection("profiles").findOne({ userId: user.id });
  if (!profile) return { needsProfile: true, jobs: [] };
  const jobs = await db.collection("jobs").find({ status: "open" }).toArray();
  const mine = new Set((await db.collection("proposals").find({ freelancerId: user.id }).toArray()).map((p) => p.jobId));
  const ranked = M.rankJobs(profile, jobs.filter((j) => !mine.has(String(j._id))).map((j) => ({ id: String(j._id), title: j.title, description: j.description, skills: j.skills, budget: j.budget })));
  const byId = new Map(jobs.map((j) => [String(j._id), j]));
  return { jobs: ranked.filter((r) => r.score >= 20).slice(0, 6).map((r) => jobView(byId.get(r.id), { score: r.score, reasons: r.reasons })) };
});

app.get("/jobs/:id", { auth: true }, async ({ db, user, params }) => {
  const job = await db.collection("jobs").findOne({ _id: oid(params.id) });
  if (!job) throw notFound("Job not found.");
  const base = jobView(job);
  if (job.clientId === user.id) {
    const props = await db.collection("proposals").find({ jobId: String(job._id) }).sort({ createdAt: -1 }).toArray();
    const fl = new Map((await freelancerViews(db, { userId: { $in: props.map((p) => p.freelancerId) } })).map((f) => [f.id, f]));
    const rankMap = new Map(M.rankFreelancers(job, [...fl.values()]).map((r) => [r.id, r]));
    const others = await db.collection("jobs").find({ status: { $in: ["in_progress", "completed"] } }).project({ skills: 1, budget: 1 }).toArray();
    return { ...base, proposalList: props.map((p) => ({ ...clean(p), freelancer: fl.get(p.freelancerId) || null, match: rankMap.get(p.freelancerId) || null })).sort((a, b) => (b.match ? b.match.score : 0) - (a.match ? a.match.score : 0)), budgetHint: M.budgetHint(job, others) };
  }
  if (user.role === "freelancer") {
    const mine = await db.collection("proposals").findOne({ jobId: String(job._id), freelancerId: user.id });
    return { ...base, myProposal: mine ? clean(mine) : null };
  }
  throw forbidden("That job belongs to another client.");
});

app.get("/jobs/:id/matches", { auth: true }, async ({ db, user, params }) => {
  need(user, "client");
  const job = await db.collection("jobs").findOne({ _id: oid(params.id), clientId: user.id });
  if (!job) throw notFound("Job not found.");
  const list = await freelancerViews(db);
  const ranked = M.rankFreelancers(job, list).slice(0, 8);
  const by = new Map(list.map((f) => [f.id, f]));
  return ranked.map((r) => ({ ...by.get(r.id), score: r.score, reasons: r.reasons, matchedSkills: r.matchedSkills }));
});

app.delete("/jobs/:id", { auth: true }, async ({ db, user, params }) => {
  need(user, "client");
  const job = await db.collection("jobs").findOne({ _id: oid(params.id), clientId: user.id });
  if (!job) throw notFound("Job not found.");
  if (job.status !== "open") throw bad("Only open jobs can be canceled.");
  await db.collection("jobs").updateOne({ _id: job._id }, { $set: { status: "cancelled" } });
  await db.collection("proposals").updateMany({ jobId: String(job._id), status: "pending" }, { $set: { status: "rejected" } });
  return { ok: true };
});

/* ---------- proposals ---------- */
app.post("/jobs/:id/proposals", { auth: true }, async ({ db, user, params, body }) => {
  need(user, "freelancer");
  if (!(await db.collection("profiles").findOne({ userId: user.id }))) throw bad("Complete your profile before sending proposals.");
  const job = await db.collection("jobs").findOne({ _id: oid(params.id) });
  if (!job || job.status !== "open") throw bad("This job is no longer open.");
  const price = toPaise(num(body.price, { min: 100, max: 1000000, label: "Price" }));
  const days = num(body.days, { min: 1, max: 365, int: true, label: "Delivery days" });
  let milestones = Array.isArray(body.milestones) && body.milestones.length ? body.milestones : [{ title: "Complete project", amount: price / 100 }];
  if (milestones.length > 6) throw bad("At most 6 milestones.");
  milestones = milestones.map((m) => ({ title: str(m.title, { min: 2, max: 80, label: "Milestone title" }), amount: toPaise(num(m.amount, { min: 1, label: "Milestone amount" })) }));
  if (milestones.reduce((s, m) => s + m.amount, 0) !== price) throw bad("Milestone amounts must add up to your price.");
  const doc = { jobId: String(job._id), freelancerId: user.id, coverLetter: str(body.coverLetter, { min: 20, max: 2000, label: "Cover letter" }), price, days, milestones, status: "pending", createdAt: new Date() };
  try {
    const { insertedId } = await db.collection("proposals").insertOne(doc);
    return created(clean({ _id: insertedId, ...doc }));
  } catch (e) {
    if (e.code === 11000) throw conflict("You already sent a proposal for this job.");
    throw e;
  }
});

app.post("/proposals/:id/withdraw", { auth: true }, async ({ db, user, params }) => {
  need(user, "freelancer");
  const r = await db.collection("proposals").updateOne({ _id: oid(params.id), freelancerId: user.id, status: "pending" }, { $set: { status: "withdrawn" } });
  if (!r.matchedCount) throw notFound("No pending proposal found.");
  return { ok: true };
});

app.post("/proposals/:id/reject", { auth: true }, async ({ db, user, params }) => {
  need(user, "client");
  const p = await db.collection("proposals").findOne({ _id: oid(params.id), status: "pending" });
  const job = p && (await db.collection("jobs").findOne({ _id: asId(p.jobId), clientId: user.id }));
  if (!job) throw notFound("Proposal not found.");
  await db.collection("proposals").updateOne({ _id: p._id }, { $set: { status: "rejected" } });
  return { ok: true };
});

app.post("/proposals/:id/accept", { auth: true }, async ({ db, user, params }) => {
  need(user, "client");
  const p = await db.collection("proposals").findOne({ _id: oid(params.id) });
  const job = p && (await db.collection("jobs").findOne({ _id: asId(p.jobId), clientId: user.id }));
  if (!job) throw notFound("Proposal not found.");
  if (p.status !== "pending") throw bad("That proposal is no longer available.");
  // only one accept can win: the job must still be open
  const won = await db.collection("jobs").updateOne({ _id: job._id, status: "open" }, { $set: { status: "in_progress", hiredFreelancerId: p.freelancerId } });
  if (!won.modifiedCount) throw bad("You already hired someone for this job.");
  const freelancer = await users(db).findOne({ _id: asId(p.freelancerId) });
  const contract = {
    jobId: String(job._id), title: job.title, clientId: user.id, clientName: user.name, freelancerId: p.freelancerId, freelancerName: freelancer.name, amount: p.price, status: "active", createdAt: new Date(),
    milestones: p.milestones.map((m) => ({ id: rid(), title: m.title, amount: m.amount, status: "pending", note: "" })),
  };
  const { insertedId } = await db.collection("contracts").insertOne(contract);
  await db.collection("proposals").updateOne({ _id: p._id }, { $set: { status: "accepted" } });
  await db.collection("proposals").updateMany({ jobId: String(job._id), status: "pending" }, { $set: { status: "rejected" } });
  return created({ id: String(insertedId) });
});

/* ---------- contracts and escrow ---------- */
async function loadContract(db, id, user) {
  const c = await db.collection("contracts").findOne({ _id: oid(id) });
  if (!c || (c.clientId !== user.id && c.freelancerId !== user.id)) throw notFound("Contract not found.");
  return c;
}

const escrowOf = (c) => c.milestones.filter((m) => HELD.includes(m.status)).reduce((s, m) => s + m.amount, 0);
const paidOut = (c) => c.milestones.reduce((s, m) => s + (m.releasedAmount || 0), 0);
const contractView = (c) => ({ ...clean(c), escrow: escrowOf(c), released: paidOut(c), progress: c.milestones.filter((m) => DONE.includes(m.status)).length / c.milestones.length });

app.get("/contracts", { auth: true }, async ({ db, user }) => {
  const list = await db.collection("contracts").find({ $or: [{ clientId: user.id }, { freelancerId: user.id }] }).sort({ createdAt: -1 }).toArray();
  return list.map(contractView);
});

app.get("/contracts/:id", { auth: true }, async ({ db, user, params }) => {
  const c = await loadContract(db, params.id, user);
  const reviews = await db.collection("reviews").find({ contractId: String(c._id) }).toArray();
  return { ...contractView(c), reviews: reviews.map(clean) };
});

// Atomically moves one milestone from one status to another; returns false if it was not in the expected state.
async function moveMilestone(db, contractId, milestoneId, from, to, extra = {}) {
  const set = { "milestones.$.status": to };
  Object.entries(extra).forEach(([k, v]) => { set[`milestones.$.${k}`] = v; });
  const r = await db.collection("contracts").updateOne({ _id: contractId, milestones: { $elemMatch: { id: milestoneId, status: { $in: Array.isArray(from) ? from : [from] } } } }, { $set: set });
  return r.modifiedCount === 1;
}

async function maybeComplete(db, contractId) {
  const c = await db.collection("contracts").findOne({ _id: contractId });
  if (c.status === "active" && c.milestones.every((m) => DONE.includes(m.status))) {
    await db.collection("contracts").updateOne({ _id: contractId, status: "active" }, { $set: { status: "completed", completedAt: new Date() } });
    await db.collection("jobs").updateOne({ _id: asId(c.jobId) }, { $set: { status: "completed" } });
    if (paidOut(c) > 0) await db.collection("profiles").updateOne({ userId: c.freelancerId }, { $inc: { jobsDone: 1 } });
  }
}

const milestoneOf = (c, mid) => {
  const m = c.milestones.find((x) => x.id === mid);
  if (!m) throw notFound("Milestone not found.");
  return m;
};

app.post("/contracts/:id/milestones/:mid/fund", { auth: true }, async ({ db, user, params }) => {
  need(user, "client");
  const c = await loadContract(db, params.id, user);
  const m = milestoneOf(c, params.mid);
  if (c.clientId !== user.id) throw forbidden();
  if (!(await moveMilestone(db, c._id, m.id, "pending", "funded", { fundedAt: new Date() }))) throw bad("That milestone is already funded.");
  if (!(await debit(db, user.id, m.amount))) {
    await moveMilestone(db, c._id, m.id, "funded", "pending");
    throw bad("Your wallet balance is too low. Add funds first.");
  }
  await txn(db, user.id, "escrow_fund", -m.amount, `Funded "${m.title}" (${c.title})`, c._id);
  return { ok: true };
});

app.post("/contracts/:id/milestones/:mid/submit", { auth: true }, async ({ db, user, params, body }) => {
  need(user, "freelancer");
  const c = await loadContract(db, params.id, user);
  const m = milestoneOf(c, params.mid);
  if (!(await moveMilestone(db, c._id, m.id, "funded", "submitted", { note: str(body.note, { min: 3, max: 1000, label: "Delivery note" }), submittedAt: new Date() }))) throw bad("Work can only be submitted on a funded milestone.");
  return { ok: true };
});

app.post("/contracts/:id/milestones/:mid/revision", { auth: true }, async ({ db, user, params, body }) => {
  need(user, "client");
  const c = await loadContract(db, params.id, user);
  const m = milestoneOf(c, params.mid);
  if (!(await moveMilestone(db, c._id, m.id, "submitted", "funded", { revisionNote: str(body.note, { min: 3, max: 500, label: "Revision request" }) }))) throw bad("There is no submitted work to send back.");
  return { ok: true };
});

async function payOut(db, c, m, amount, note) {
  const fee = Math.round(amount * FEE_RATE);
  await credit(db, c.freelancerId, amount - fee);
  await txn(db, c.freelancerId, "escrow_release", amount - fee, `${note} (${c.title})`, c._id);
  if (fee) await txn(db, "platform", "platform_fee", fee, `5% fee on "${m.title}"`, c._id);
  return { fee, payout: amount - fee };
}

app.post("/contracts/:id/milestones/:mid/release", { auth: true }, async ({ db, user, params }) => {
  need(user, "client");
  const c = await loadContract(db, params.id, user);
  const m = milestoneOf(c, params.mid);
  if (!(await moveMilestone(db, c._id, m.id, "submitted", "released", { releasedAmount: m.amount, releasedAt: new Date() }))) throw bad("Only submitted work can be released.");
  const r = await payOut(db, c, m, m.amount, `Payment for "${m.title}"`);
  await maybeComplete(db, c._id);
  return { ok: true, ...r };
});

app.post("/contracts/:id/milestones/:mid/dispute", { auth: true }, async ({ db, user, params, body }) => {
  const c = await loadContract(db, params.id, user);
  const m = milestoneOf(c, params.mid);
  if (!(await moveMilestone(db, c._id, m.id, ["funded", "submitted"], "disputed", { disputeReason: str(body.reason, { min: 5, max: 500, label: "Reason" }), disputedBy: user.id }))) throw bad("Only funded or submitted milestones can be disputed.");
  return { ok: true };
});

// Simulated arbitration: if the freelancer delivered work, 70% is released to them and 30% refunded; if nothing was delivered, everything is refunded.
app.post("/contracts/:id/milestones/:mid/arbitrate", { auth: true }, async ({ db, user, params }) => {
  const c = await loadContract(db, params.id, user);
  const m = milestoneOf(c, params.mid);
  const delivered = Boolean(m.submittedAt);
  const toFreelancer = delivered ? Math.round(m.amount * 0.7) : 0;
  const refund = m.amount - toFreelancer;
  if (!(await moveMilestone(db, c._id, m.id, "disputed", "resolved", { releasedAmount: toFreelancer, refundedAmount: refund, resolvedAt: new Date() }))) throw bad("Only disputed milestones can be arbitrated.");
  if (toFreelancer) await payOut(db, c, m, toFreelancer, `Arbitration payout for "${m.title}"`);
  if (refund) {
    await credit(db, c.clientId, refund);
    await txn(db, c.clientId, "escrow_refund", refund, `Refund for "${m.title}" (${c.title})`, c._id);
  }
  await maybeComplete(db, c._id);
  return { ok: true, toFreelancer, refund };
});

/* ---------- messages and reviews ---------- */
app.get("/contracts/:id/messages", { auth: true }, async ({ db, user, params }) => {
  const c = await loadContract(db, params.id, user);
  return (await db.collection("messages").find({ contractId: String(c._id) }).sort({ at: 1 }).limit(200).toArray()).map(clean);
});

app.post("/contracts/:id/messages", { auth: true }, async ({ db, user, params, body }) => {
  const c = await loadContract(db, params.id, user);
  const doc = { contractId: String(c._id), userId: user.id, userName: user.name, text: str(body.text, { min: 1, max: 1000, label: "Message" }), at: new Date() };
  const { insertedId } = await db.collection("messages").insertOne(doc);
  return created(clean({ _id: insertedId, ...doc }));
});

app.post("/contracts/:id/review", { auth: true }, async ({ db, user, params, body }) => {
  const c = await loadContract(db, params.id, user);
  if (c.status !== "completed") throw bad("You can review once the contract is completed.");
  const toId = c.clientId === user.id ? c.freelancerId : c.clientId;
  const rating = num(body.rating, { min: 1, max: 5, int: true, label: "Rating" });
  try {
    await db.collection("reviews").insertOne({ contractId: String(c._id), fromId: user.id, fromName: user.name, toId, rating, comment: str(body.comment, { max: 500 }), at: new Date() });
  } catch (e) {
    if (e.code === 11000) throw conflict("You already reviewed this contract.");
    throw e;
  }
  if (toId === c.freelancerId) await db.collection("profiles").updateOne({ userId: toId }, { $inc: { ratingSum: rating, reviews: 1 } });
  return created({ ok: true });
});

/* ---------- wallet ---------- */
app.get("/wallet", { auth: true }, async ({ db, user }) => {
  const me = await users(db).findOne({ _id: asId(user.id) });
  const contracts = await db.collection("contracts").find({ [user.role === "client" ? "clientId" : "freelancerId"]: user.id }).toArray();
  const tx = await db.collection("transactions").find({ userId: user.id }).sort({ at: -1 }).limit(40).toArray();
  return { balance: me.balance || 0, escrow: contracts.reduce((s, c) => s + escrowOf(c), 0), transactions: tx.map(clean) };
});

app.post("/wallet/deposit", { auth: true }, async ({ db, user, body }) => {
  need(user, "client");
  const amount = toPaise(num(body.amount, { min: 100, max: 100000, label: "Amount" }));
  const me = await users(db).findOne({ _id: asId(user.id) });
  if ((me.balance || 0) + amount > toPaise(500000)) throw bad("Demo wallets are capped at ₹5,00,000.");
  await credit(db, user.id, amount);
  await txn(db, user.id, "deposit", amount, "Added demo funds");
  return { ok: true };
});

app.post("/wallet/withdraw", { auth: true }, async ({ db, user, body }) => {
  need(user, "freelancer");
  const amount = toPaise(num(body.amount, { min: 100, max: 1000000, label: "Amount" }));
  if (!(await debit(db, user.id, amount))) throw bad("You cannot withdraw more than your balance.");
  await txn(db, user.id, "withdraw", -amount, "Withdrawn to bank (simulated)");
  return { ok: true };
});

/* ---------- overview ---------- */
app.get("/overview", { auth: true }, async ({ db, user }) => {
  const me = await users(db).findOne({ _id: asId(user.id) });
  if (user.role === "client") {
    const [jobs, contracts] = await Promise.all([db.collection("jobs").find({ clientId: user.id }).toArray(), db.collection("contracts").find({ clientId: user.id }).toArray()]);
    return { role: "client", balance: me.balance || 0, openJobs: jobs.filter((j) => j.status === "open").length, activeContracts: contracts.filter((c) => c.status === "active").length, inEscrow: contracts.reduce((s, c) => s + escrowOf(c), 0), spent: contracts.reduce((s, c) => s + paidOut(c), 0) };
  }
  const [contracts, proposals, profile] = await Promise.all([db.collection("contracts").find({ freelancerId: user.id }).toArray(), db.collection("proposals").find({ freelancerId: user.id, status: "pending" }).toArray(), db.collection("profiles").findOne({ userId: user.id })]);
  return {
    role: "freelancer", balance: me.balance || 0, activeContracts: contracts.filter((c) => c.status === "active").length, pendingProposals: proposals.length, incoming: contracts.reduce((s, c) => s + escrowOf(c), 0),
    earned: contracts.reduce((s, c) => s + Math.round(paidOut(c) * (1 - FEE_RATE)), 0), rating: profile && profile.reviews ? Math.round((profile.ratingSum / profile.reviews) * 10) / 10 : 0, hasProfile: Boolean(profile),
  };
});

module.exports = app;
