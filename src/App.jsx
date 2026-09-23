import { useEffect, useRef, useState } from "react";
import {
  AppShell, AuthProvider, AuthScreen, Avatar, Badge, Empty, ErrorNote, Field, Loading, Modal, Stat, ToastProvider,
  ago, api, dateFmt, money, useApi, useAsync, useAuth, useHashRoute,
} from "./kit.jsx";

const rs = (paise) => money((paise || 0) / 100);
const msKind = { pending: "", funded: "accent", submitted: "warn", released: "ok", refunded: "", resolved: "ok", disputed: "danger" };

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  );
}

function Gate() {
  const { user } = useAuth();
  if (user === undefined) return <Loading />;
  if (!user) {
    return (
      <AuthScreen
        title="TalentBridge"
        tagline="Hire great freelancers. Pay safely, milestone by milestone."
        points={["Explainable smart matching between jobs and freelancers", "Escrow holds your money until work is approved", "Milestones, revisions and dispute resolution", "Reviews that build real reputation"]}
        roles={[{ value: "client", label: "Client: I want to hire" }, { value: "freelancer", label: "Freelancer: I want to work" }]}
      />
    );
  }
  return <Router />;
}

function Router() {
  const { user } = useAuth();
  const { path, go } = useHashRoute("/");
  const isClient = user.role === "client";
  const nav = isClient
    ? [{ to: "/", label: "Dashboard" }, { to: "/post", label: "Post a job" }, { to: "/jobs", label: "My jobs" }, { to: "/talent", label: "Find talent" }, { to: "/contracts", label: "Contracts" }, { to: "/wallet", label: "Wallet" }]
    : [{ to: "/", label: "Dashboard" }, { to: "/jobs", label: "Find work" }, { to: "/profile", label: "My profile" }, { to: "/contracts", label: "Contracts" }, { to: "/wallet", label: "Wallet" }];
  const job = path.match(/^\/jobs\/([a-f0-9]{24})$/);
  const contract = path.match(/^\/contracts\/([a-f0-9]{24})$/);
  return (
    <AppShell brand="TalentBridge" mark="T" nav={nav} path={path} go={go}>
      {path === "/" && <Dashboard go={go} />}
      {path === "/post" && isClient && <PostJob go={go} />}
      {path === "/jobs" && (isClient ? <MyJobs /> : <FindWork />)}
      {job && <JobDetail id={job[1]} go={go} />}
      {path === "/talent" && <Talent />}
      {path === "/profile" && !isClient && <ProfileForm />}
      {path === "/contracts" && <Contracts />}
      {contract && <ContractView id={contract[1]} />}
      {path === "/wallet" && <Wallet />}
    </AppShell>
  );
}

function Score({ value }) {
  const tone = value >= 70 ? "ok" : value >= 40 ? "warn" : "";
  return <Badge kind={tone}>{value}% match</Badge>;
}

function Skills({ list, highlight = [] }) {
  return <div className="row wrap" style={{ gap: "0.3rem" }}>{list.map((s) => <Badge key={s} kind={highlight.includes(s) ? "accent" : ""}>{s}</Badge>)}</div>;
}

/* ---------- Dashboard ---------- */
function Dashboard({ go }) {
  const { user } = useAuth();
  const ov = useApi("/overview");
  const rec = useApi("/jobs/recommended", { skip: user.role !== "freelancer" });
  if (ov.loading) return <Loading />;
  if (ov.error) return <ErrorNote message={ov.error} onRetry={ov.reload} />;
  const d = ov.data;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Welcome, {user.name.split(" ")[0]}</h1><p>{d.role === "client" ? "Post work, review proposals and pay safely through escrow." : "Find work that fits your skills and get paid through escrow."}</p></div></div>
      {d.role === "client" ? (
        <div className="grid cols-4">
          <Stat label="Wallet" value={rs(d.balance)} /><Stat label="In escrow" value={rs(d.inEscrow)} /><Stat label="Open jobs" value={d.openJobs} hint={`${d.activeContracts} active contracts`} /><Stat label="Paid out" value={rs(d.spent)} />
        </div>
      ) : (
        <div className="grid cols-4">
          <Stat label="Available" value={rs(d.balance)} /><Stat label="Coming from escrow" value={rs(d.incoming)} /><Stat label="Earned (after 5% fee)" value={rs(d.earned)} /><Stat label="Rating" value={d.rating ? `${d.rating} / 5` : "-"} hint={`${d.pendingProposals} proposals pending`} />
        </div>
      )}
      {d.role === "freelancer" && !d.hasProfile && <div className="card row between wrap"><div><b>Complete your profile</b><p className="muted small" style={{ margin: 0 }}>Clients find you through your skills. You cannot send proposals until it is done.</p></div><button className="btn" onClick={() => go("/profile")}>Set up profile</button></div>}
      {d.role === "freelancer" && rec.data && rec.data.jobs.length > 0 && (
        <div className="stack-sm"><h2 style={{ marginBottom: 0 }}>Recommended for you</h2>
          <div className="auto-grid">{rec.data.jobs.map((j) => <JobCard key={j.id} job={j} extra={<div className="stack-sm"><Score value={j.score} />{j.reasons.map((r) => <div key={r} className="small muted">• {r}</div>)}</div>} />)}</div></div>
      )}
      {d.role === "client" && d.openJobs === 0 && d.activeContracts === 0 && <Empty title="Nothing here yet"><button className="btn" onClick={() => go("/post")}>Post your first job</button></Empty>}
    </div>
  );
}

function JobCard({ job, extra }) {
  return (
    <a href={`#/jobs/${job.id}`} className="card hover stack-sm" style={{ color: "inherit", textDecoration: "none" }}>
      <div className="row between"><h3 style={{ margin: 0 }}>{job.title}</h3><b>{rs(job.budget)}</b></div>
      <p className="muted small" style={{ margin: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{job.description}</p>
      <Skills list={job.skills} />
      <div className="row between small muted"><span>{job.clientName} · due {dateFmt(job.deadline)}</span>{job.proposals !== undefined && <span>{job.proposals} proposal{job.proposals === 1 ? "" : "s"}</span>}</div>
      {extra}
    </a>
  );
}

/* ---------- Jobs ---------- */
function PostJob({ go }) {
  const [f, setF] = useState({ title: "", description: "", budget: "", deadline: "", skills: "" });
  const { busy, run } = useAsync();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const suggest = async () => { const r = await run(() => api("/skills/extract", { method: "POST", body: { title: f.title, description: f.description } })); if (r) setF({ ...f, skills: r.skills.join(", ") }); };
  const save = async (e) => { e.preventDefault(); const j = await run(() => api("/jobs", { method: "POST", body: f }), "Job posted"); if (j) go(`/jobs/${j.id}`); };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head"><div><h1>Post a job</h1><p>Describe the work and we will rank the best freelancers for it.</p></div></div>
      <form className="card stack-sm" onSubmit={save}>
        <Field label="Title"><input className="input" value={f.title} onChange={set("title")} placeholder="e.g. Build a React dashboard with a Node API" /></Field>
        <Field label="Description"><textarea className="input" style={{ minHeight: 140 }} value={f.description} onChange={set("description")} placeholder="What needs doing, and what does done look like?" /></Field>
        <div className="grid cols-2"><Field label="Budget (INR)"><input className="input" type="number" min="500" value={f.budget} onChange={set("budget")} /></Field><Field label="Deadline"><input className="input" type="date" value={f.deadline} onChange={set("deadline")} /></Field></div>
        <Field label="Skills (comma separated)"><input className="input" value={f.skills} onChange={set("skills")} placeholder="Leave empty and they are detected from your text" /></Field>
        <div className="row between"><button type="button" className="btn ghost" onClick={suggest} disabled={busy}>Suggest skills from my text</button><button className="btn" disabled={busy}>Post job</button></div>
      </form>
    </div>
  );
}

function MyJobs() {
  const { data, loading, error, reload } = useApi("/jobs");
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>My jobs</h1><p>{data.length} posted</p></div></div>
      {data.length === 0 && <Empty title="No jobs yet">Post one to start receiving proposals.</Empty>}
      <div className="auto-grid">{data.map((j) => <JobCard key={j.id} job={j} extra={<Badge kind={{ open: "accent", in_progress: "warn", completed: "ok", cancelled: "danger" }[j.status]}>{j.status.replace("_", " ")}</Badge>} />)}</div>
    </div>
  );
}

function FindWork() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const { data, loading, error, reload } = useApi(`/jobs${term ? `?q=${encodeURIComponent(term)}` : ""}`);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Find work</h1><p>Search ranks jobs by relevance to what you type.</p></div></div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setTerm(q); }}><input className="input" style={{ maxWidth: 420 }} placeholder="e.g. react dashboard, seo, figma" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn">Search</button>{term && <button type="button" className="btn ghost" onClick={() => { setQ(""); setTerm(""); }}>Clear</button>}</form>
      {loading && <Loading />}
      {error && <ErrorNote message={error} onRetry={reload} />}
      {data && data.length === 0 && <Empty title="No jobs found">Try different words.</Empty>}
      <div className="auto-grid">{(data || []).map((j) => <JobCard key={j.id} job={j} extra={j.myProposal ? <Badge kind="accent">Your proposal: {j.myProposal}</Badge> : null} />)}</div>
    </div>
  );
}

function JobDetail({ id, go }) {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi(`/jobs/${id}`);
  const matches = useApi(`/jobs/${id}/matches`, { skip: user.role !== "client" });
  const [proposing, setProposing] = useState(false);
  const { run } = useAsync();
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  const isOwner = data.clientId === user.id;
  const act = async (path, msg) => { const r = await run(() => api(path, { method: "POST", body: {} }), msg); if (r) reload(true); return r; };
  return (
    <div className="stack">
      <div className="page-head"><div><h1>{data.title}</h1><p>{data.clientName} · budget {rs(data.budget)} · due {dateFmt(data.deadline)}</p></div><Badge kind={{ open: "accent", in_progress: "warn", completed: "ok", cancelled: "danger" }[data.status]}>{data.status.replace("_", " ")}</Badge></div>
      <div className="card stack-sm"><p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{data.description}</p><Skills list={data.skills} /></div>
      {!isOwner && user.role === "freelancer" && (
        data.myProposal ? <div className="card stack-sm"><div className="row between"><h3 style={{ margin: 0 }}>Your proposal</h3><Badge kind="accent">{data.myProposal.status}</Badge></div><p style={{ margin: 0 }}>{rs(data.myProposal.price)} in {data.myProposal.days} days</p>
          {data.myProposal.status === "pending" && <div><button className="btn ghost sm" onClick={() => act(`/proposals/${data.myProposal.id}/withdraw`, "Proposal withdrawn")}>Withdraw</button></div>}</div>
          : data.status === "open" && <div><button className="btn" onClick={() => setProposing(true)}>Send a proposal</button></div>
      )}
      {isOwner && (
        <>
          {data.budgetHint && <div className="card small">Similar jobs on TalentBridge typically cost between <b>{rs(data.budgetHint.low)}</b> and <b>{rs(data.budgetHint.high)}</b> (median {rs(data.budgetHint.median)}, from {data.budgetHint.sample} jobs).</div>}
          <h2 style={{ marginBottom: 0 }}>Proposals ({data.proposalList.length})</h2>
          {data.proposalList.length === 0 && <Empty title="No proposals yet">Freelancers will see your job. Meanwhile, check the top matches below.</Empty>}
          {data.proposalList.map((p) => (
            <div key={p.id} className="card stack-sm">
              <div className="row between wrap"><div className="row"><Avatar name={p.freelancer ? p.freelancer.name : "?"} /><div><b>{p.freelancer ? p.freelancer.name : "Unknown"}</b><div className="muted small">{p.freelancer && p.freelancer.headline}</div></div></div>
                <div className="row">{p.match && <Score value={p.match.score} />}<b>{rs(p.price)}</b><span className="muted small">{p.days} days</span></div></div>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{p.coverLetter}</p>
              {p.match && p.match.reasons.map((r) => <div key={r} className="small muted">• {r}</div>)}
              <div className="small muted">{p.milestones.map((m) => `${m.title} (${rs(m.amount)})`).join(" · ")}</div>
              {p.status === "pending" && data.status === "open" ? <div className="row"><button className="btn" onClick={async () => { const r = await run(() => api(`/proposals/${p.id}/accept`, { method: "POST", body: {} }), "Hired! Fund the first milestone to begin."); if (r) go(`/contracts/${r.id}`); }}>Accept and hire</button><button className="btn ghost" onClick={() => act(`/proposals/${p.id}/reject`, "Proposal declined")}>Decline</button></div> : <Badge kind={p.status === "accepted" ? "ok" : ""}>{p.status}</Badge>}
            </div>
          ))}
          {data.status === "open" && (
            <div><button className="btn ghost" onClick={async () => { if (window.confirm("Cancel this job? Pending proposals will be declined.")) { if (await run(() => api(`/jobs/${id}`, { method: "DELETE" }), "Job canceled")) go("/jobs"); } }}>Cancel job</button></div>
          )}
          <h2 style={{ marginBottom: 0 }}>Top matches for this job</h2>
          {!matches.data ? <Loading /> : <div className="auto-grid">{matches.data.map((m) => <FreelancerCard key={m.id} f={m} score={m.score} reasons={m.reasons} />)}</div>}
        </>
      )}
      {proposing && <ProposalForm job={data} onClose={() => setProposing(false)} onSaved={() => { setProposing(false); reload(true); }} />}
    </div>
  );
}

function ProposalForm({ job, onClose, onSaved }) {
  const [f, setF] = useState({ coverLetter: "", price: job.budget / 100, days: 14 });
  const [ms, setMs] = useState([]);
  const { busy, run } = useAsync();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const sum = ms.reduce((s, m) => s + Number(m.amount || 0), 0);
  const save = async (e) => { e.preventDefault(); if (await run(() => api(`/jobs/${job.id}/proposals`, { method: "POST", body: { ...f, milestones: ms.length ? ms : undefined } }), "Proposal sent")) onSaved(); };
  return (
    <Modal title="Send a proposal" onClose={onClose} wide>
      <form className="stack-sm" onSubmit={save}>
        <Field label="Cover letter"><textarea className="input" value={f.coverLetter} onChange={set("coverLetter")} placeholder="Why are you a good fit?" /></Field>
        <div className="grid cols-2"><Field label="Your price (INR)"><input className="input" type="number" min="100" value={f.price} onChange={set("price")} /></Field><Field label="Delivery (days)"><input className="input" type="number" min="1" value={f.days} onChange={set("days")} /></Field></div>
        <div className="stack-sm"><div className="row between"><b>Milestones</b><button type="button" className="btn ghost sm" onClick={() => setMs([...ms, { title: "", amount: "" }])} disabled={ms.length >= 6}>+ Add milestone</button></div>
          {ms.length === 0 && <p className="muted small" style={{ margin: 0 }}>Optional. Without milestones the whole price is paid on delivery. Milestones must add up to your price.</p>}
          {ms.map((m, i) => (
            <div key={i} className="grid" style={{ gridTemplateColumns: "2fr 1fr auto", alignItems: "center" }}>
              <input className="input" placeholder="Milestone title" value={m.title} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input className="input" type="number" min="1" placeholder="Amount" value={m.amount} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" className="icon-btn" onClick={() => setMs(ms.filter((_, j) => j !== i))} aria-label="Remove milestone">×</button>
            </div>
          ))}
          {ms.length > 0 && <span className={`small ${sum === Number(f.price) ? "muted" : ""}`} style={{ color: sum === Number(f.price) ? undefined : "var(--danger)" }}>Milestones total {money(sum)} of {money(Number(f.price) || 0)}</span>}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" disabled={busy}>Send proposal</button></div>
      </form>
    </Modal>
  );
}

/* ---------- Talent + profile ---------- */
function FreelancerCard({ f, score, reasons }) {
  return (
    <div className="card stack-sm">
      <div className="row between"><div className="row"><Avatar name={f.name} /><div><b>{f.name}</b><div className="muted small">{f.headline}</div></div></div>{score !== undefined && <Score value={score} />}</div>
      <p className="muted small" style={{ margin: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{f.bio}</p>
      <Skills list={f.skills} highlight={f.matchedSkills || []} />
      <div className="row between small"><span>{f.rating ? `★ ${f.rating} (${f.reviews})` : "New"} · {f.jobsDone} jobs</span><b>{rs(f.rate * 100)}/hr</b></div>
      {reasons && reasons.map((r) => <div key={r} className="small muted">• {r}</div>)}
    </div>
  );
}

function Talent() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const { data, loading, error, reload } = useApi(`/freelancers${term ? `?q=${encodeURIComponent(term)}` : ""}`);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Find talent</h1><p>Type what you need, results are ranked by relevance.</p></div></div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setTerm(q); }}><input className="input" style={{ maxWidth: 420 }} placeholder="e.g. figma brand designer" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn">Search</button>{term && <button type="button" className="btn ghost" onClick={() => { setQ(""); setTerm(""); }}>Clear</button>}</form>
      {loading && <Loading />}
      {error && <ErrorNote message={error} onRetry={reload} />}
      {data && data.length === 0 && <Empty title="No one matches">Try other words.</Empty>}
      <div className="auto-grid">{(data || []).map((f) => <FreelancerCard key={f.id} f={f} score={f.relevance} />)}</div>
    </div>
  );
}

function ProfileForm() {
  const { data, loading } = useApi("/profile");
  const [f, setF] = useState(null);
  const { busy, run } = useAsync();
  useEffect(() => { if (!loading) setF(data ? { headline: data.headline, bio: data.bio, skills: data.skills.join(", "), rate: data.rate } : { headline: "", bio: "", skills: "", rate: 800 }); }, [loading, data]);
  if (!f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => { e.preventDefault(); await run(() => api("/profile", { method: "PUT", body: f }), "Profile saved"); };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head"><div><h1>My profile</h1><p>Clients search and are matched on these details.</p></div></div>
      <form className="card stack-sm" onSubmit={save}>
        <Field label="Headline"><input className="input" value={f.headline} onChange={set("headline")} placeholder="e.g. React developer for SaaS products" /></Field>
        <Field label="About you"><textarea className="input" style={{ minHeight: 120 }} value={f.bio} onChange={set("bio")} /></Field>
        <div className="grid cols-2"><Field label="Skills (comma separated)"><input className="input" value={f.skills} onChange={set("skills")} placeholder="react, node, mongodb" /></Field><Field label="Hourly rate (INR)"><input className="input" type="number" min="100" value={f.rate} onChange={set("rate")} /></Field></div>
        <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" disabled={busy}>Save profile</button></div>
      </form>
    </div>
  );
}

/* ---------- Contracts and escrow ---------- */
function Contracts() {
  const { data, loading, error, reload } = useApi("/contracts");
  const { user } = useAuth();
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Contracts</h1><p>Work in progress and completed.</p></div></div>
      {data.length === 0 && <Empty title="No contracts yet">{user.role === "client" ? "Accept a proposal to start one." : "Win a job and it will appear here."}</Empty>}
      <div className="auto-grid">
        {data.map((c) => (
          <a key={c.id} href={`#/contracts/${c.id}`} className="card hover stack-sm" style={{ color: "inherit", textDecoration: "none" }}>
            <div className="row between"><h3 style={{ margin: 0 }}>{c.title}</h3><Badge kind={c.status === "completed" ? "ok" : "accent"}>{c.status}</Badge></div>
            <div className="muted small">{user.role === "client" ? `with ${c.freelancerName}` : `for ${c.clientName}`} · {rs(c.amount)}</div>
            <div className="progress"><i style={{ width: `${c.progress * 100}%` }} /></div>
            <div className="small muted">{rs(c.escrow)} in escrow · {rs(c.released)} released</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function ContractView({ id }) {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi(`/contracts/${id}`, { poll: 4000 });
  const { run } = useAsync();
  const [note, setNote] = useState({});
  const [review, setReview] = useState({ rating: 5, comment: "" });
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  const isClient = data.clientId === user.id;
  const step = async (m, action, body, msg) => { const r = await run(() => api(`/contracts/${id}/milestones/${m.id}/${action}`, { method: "POST", body: body || {} }), msg); if (r) reload(true); };
  const reviewed = data.reviews.some((r) => r.fromId === user.id);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>{data.title}</h1><p>{isClient ? `Freelancer: ${data.freelancerName}` : `Client: ${data.clientName}`} · total {rs(data.amount)}</p></div><Badge kind={data.status === "completed" ? "ok" : "accent"}>{data.status}</Badge></div>
      <div className="grid cols-3"><Stat label="In escrow" value={rs(data.escrow)} /><Stat label="Paid out" value={rs(data.released)} /><Stat label="Platform fee" value="5%" hint="Deducted from each payout" /></div>
      <h2 style={{ marginBottom: 0 }}>Milestones</h2>
      {data.milestones.map((m, i) => (
        <div key={m.id} className="card stack-sm">
          <div className="row between wrap"><div><b>{i + 1}. {m.title}</b><div className="muted small">{rs(m.amount)}</div></div><Badge kind={msKind[m.status]}>{m.status}</Badge></div>
          {m.note && <div className="small"><b>Delivery note:</b> {m.note}</div>}
          {m.revisionNote && m.status === "funded" && <div className="small" style={{ color: "var(--warn)" }}><b>Revision requested:</b> {m.revisionNote}</div>}
          {m.disputeReason && <div className="small" style={{ color: "var(--danger)" }}><b>Dispute:</b> {m.disputeReason}</div>}
          {m.status === "resolved" && <div className="small muted">Arbitration: {rs(m.releasedAmount)} to the freelancer, {rs(m.refundedAmount)} refunded.</div>}
          {data.status === "active" && (
            <div className="row wrap">
              {isClient && m.status === "pending" && <button className="btn" onClick={() => step(m, "fund", {}, "Milestone funded, money is now held in escrow")}>Fund milestone</button>}
              {!isClient && m.status === "funded" && <><input className="input" style={{ maxWidth: 320 }} placeholder="Delivery note or link" value={note[m.id] || ""} onChange={(e) => setNote({ ...note, [m.id]: e.target.value })} /><button className="btn" onClick={() => step(m, "submit", { note: note[m.id] }, "Work submitted")}>Submit work</button></>}
              {isClient && m.status === "submitted" && <><button className="btn ok" onClick={() => step(m, "release", {}, "Payment released")}>Approve and release</button><button className="btn ghost" onClick={() => { const n = window.prompt("What needs to change?"); if (n) step(m, "revision", { note: n }, "Sent back for revision"); }}>Request revision</button></>}
              {["funded", "submitted"].includes(m.status) && <button className="btn ghost sm" onClick={() => { const r = window.prompt("Reason for the dispute"); if (r) step(m, "dispute", { reason: r }, "Dispute opened"); }}>Dispute</button>}
              {m.status === "disputed" && <button className="btn danger" onClick={() => step(m, "arbitrate", {}, "Arbitration complete")}>Run arbitration (demo)</button>}
            </div>
          )}
        </div>
      ))}
      {data.status === "completed" && !reviewed && (
        <div className="card stack-sm"><h3>Leave a review</h3>
          <div className="grid cols-2"><Field label="Rating"><select className="input" value={review.rating} onChange={(e) => setReview({ ...review, rating: e.target.value })}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)} ({n})</option>)}</select></Field><Field label="Comment"><input className="input" value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} /></Field></div>
          <div><button className="btn" onClick={async () => { if (await run(() => api(`/contracts/${id}/review`, { method: "POST", body: review }), "Thanks for your review")) reload(true); }}>Submit review</button></div></div>
      )}
      {data.reviews.map((r) => <div key={r.id} className="card small"><b>{r.fromName}</b> rated {"★".repeat(r.rating)} {r.comment && `· ${r.comment}`}</div>)}
      <Chat contractId={id} />
    </div>
  );
}

function Chat({ contractId }) {
  const { user } = useAuth();
  const { data, reload } = useApi(`/contracts/${contractId}/messages`, { poll: 3000 });
  const [text, setText] = useState("");
  const end = useRef(null);
  const { run } = useAsync();
  useEffect(() => { if (end.current) end.current.scrollTop = end.current.scrollHeight; }, [data]);
  const send = async (e) => { e.preventDefault(); if (!text.trim()) return; const t = text; setText(""); await run(() => api(`/contracts/${contractId}/messages`, { method: "POST", body: { text: t } })); reload(true); };
  return (
    <div className="card stack-sm"><h3 style={{ margin: 0 }}>Messages</h3>
      <div ref={end} style={{ maxHeight: 260, overflowY: "auto", display: "grid", gap: "0.4rem" }}>
        {data && data.length === 0 && <p className="muted small">No messages yet.</p>}
        {(data || []).map((m) => <div key={m.id} className="small" style={{ justifySelf: m.userId === user.id ? "end" : "start", background: m.userId === user.id ? "var(--accent-soft)" : "var(--surface-2)", padding: "0.4rem 0.7rem", borderRadius: 10, maxWidth: "80%" }}><b>{m.userName}</b> <span className="muted">{ago(m.at)}</span><div>{m.text}</div></div>)}
      </div>
      <form className="row" onSubmit={send}><input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message" /><button className="btn">Send</button></form>
    </div>
  );
}

/* ---------- Wallet ---------- */
function Wallet() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi("/wallet");
  const [amount, setAmount] = useState(10000);
  const { busy, run } = useAsync();
  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  const isClient = user.role === "client";
  const go = async () => { if (await run(() => api(isClient ? "/wallet/deposit" : "/wallet/withdraw", { method: "POST", body: { amount } }), isClient ? "Demo funds added" : "Withdrawal requested")) reload(true); };
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Wallet</h1><p>Demo money only. No real payments are made.</p></div></div>
      <div className="grid cols-3"><Stat label="Available" value={rs(data.balance)} /><Stat label={isClient ? "Held in escrow" : "Coming from escrow"} value={rs(data.escrow)} /></div>
      <div className="card row wrap" style={{ alignItems: "end" }}><Field label={isClient ? "Add demo funds (INR)" : "Withdraw (INR)"}><input className="input" type="number" min="100" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><button className="btn" disabled={busy} onClick={go}>{isClient ? "Add funds" : "Withdraw"}</button></div>
      <h2 style={{ marginBottom: 0 }}>Transactions</h2>
      {data.transactions.length === 0 ? <Empty title="No transactions yet">Deposits, escrow payments and payouts show up here.</Empty> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Type</th><th>Note</th><th className="num">Amount</th></tr></thead>
          <tbody>{data.transactions.map((t) => <tr key={t.id}><td className="small">{ago(t.at)}</td><td><Badge kind={t.amount >= 0 ? "ok" : ""}>{t.type.replace("_", " ")}</Badge></td><td className="small">{t.note}</td><td className="num"><b style={{ color: t.amount >= 0 ? "var(--ok)" : "inherit" }}>{t.amount >= 0 ? "+" : ""}{rs(t.amount)}</b></td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
