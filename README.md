# TalentBridge: freelance marketplace with smart matching and escrow

A marketplace where clients post jobs and freelancers send proposals, with **explainable smart matching** to rank the best people for a job and **milestone escrow** so clients only pay for approved work.

**Stack:** React 19 + Vite, Node.js serverless functions on Vercel, MongoDB Atlas, JWT sessions in HttpOnly cookies, bcrypt.

> Money is simulated (demo wallets, no real payments). The database is pre-filled with demo freelancers and jobs so a new visitor has something to explore.

## The "AI" is explainable matching, not an LLM
There is no external AI service. Matching is classic information retrieval, written from scratch in `api/_lib/match.js` and unit tested:
- **TF-IDF cosine similarity** between the job text and each freelancer's headline, bio and skills (skills are weighted higher)
- **Skill overlap** between the job's required skills and the freelancer's skills
- **Rating and budget fit** as smaller factors
- Every score comes with **plain-language reasons** ("Has 3 of 4 required skills: react, node, mongodb", "Rated 4.9 from 31 reviews"), so a client can see *why* someone was ranked first
- **Skill extraction** reads a job description and suggests skills, with aliases (`Node.js` becomes `node`, `ML` becomes `machine learning`)
- **Budget hints** show the typical range (quartiles and median) paid for similar jobs
- Freelancers get **recommended jobs** ranked against their own profile, and both sides get relevance-ranked search

## Escrow flow
1. The client accepts a proposal, which creates a **contract** with the proposal's milestones (all `pending`)
2. The client **funds** a milestone: money moves from their wallet into escrow (`funded`)
3. The freelancer **submits** work with a note (`submitted`); the client can **request a revision** (back to `funded`)
4. The client **approves and releases**: the freelancer is paid 95% and the platform keeps a 5% fee (`released`)
5. Either side can **dispute** a funded or submitted milestone. The demo arbitrator refunds everything if nothing was delivered, or splits 70/30 (freelancer/client) if work was delivered
6. When every milestone is settled the contract and job complete, and both sides can leave a **review** that updates the freelancer's rating

### Correctness
- Every state change is an atomic compare-and-set on the milestone status, so releasing or funding twice cannot pay twice. The tests fire 5 simultaneous fund requests at one milestone and check exactly one succeeds and the wallet is debited once.
- Wallet debits are conditional (`balance >= amount`), so balances never go negative.
- Money is conserved: a test checks that client wallet + freelancer wallet + platform fee + escrow equals everything deposited.
- Hiring is a compare-and-set on the job (`open` to `in_progress`), so only one proposal can ever win.

## API
One serverless function (`api/index.js`, reached through a `vercel.json` rewrite) routes every request.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup` (role `client` or `freelancer`), `/auth/login`, `/auth/logout`, `GET /auth/me` |
| Talent | `GET/PUT /profile`, `GET /freelancers?q=`, `GET /freelancers/:id` |
| Jobs | `POST/GET /jobs`, `GET /jobs/:id`, `GET /jobs/recommended`, `GET /jobs/:id/matches`, `DELETE /jobs/:id`, `POST /skills/extract` |
| Proposals | `POST /jobs/:id/proposals`, `POST /proposals/:id/accept`, `/reject`, `/withdraw` |
| Contracts | `GET /contracts`, `GET /contracts/:id`, milestone actions `fund`, `submit`, `revision`, `release`, `dispute`, `arbitrate`, `GET/POST /contracts/:id/messages`, `POST /contracts/:id/review` |
| Wallet | `GET /wallet`, `POST /wallet/deposit`, `POST /wallet/withdraw`, `GET /overview` |

## Run it locally
```bash
npm install
npm run build
```
The API needs a `MONGODB_URI` environment variable and Vercel's function runtime, so run `vercel dev` (or deploy to Vercel and add `MONGODB_URI`). Data goes to the `freelance_marketplace` database.

This is a public demo database: please do not enter real personal details.
