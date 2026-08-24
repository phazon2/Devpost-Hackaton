# CLAUDE.md — Doorman

Project memory. **Read this in full at the start of every session.** It is self-contained: assume no prior
conversation, no carried-over state, and nothing in your context that is not in this file or `BUILD-SPEC.md`.

---

## 0a. Companion repo — execution rules live in a second repository

**`https://github.com/phazon2/hack-template`** carries Diego's cross-project execution rules in its
`CLAUDE.md`. **Read it at the start of every session, before doing anything**, and treat it as binding.
It is public; clone it read-only:

```
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/phazon2/hack-template \
  /home/user/phazon2/hack-template
```

**It is a source of rules, never a destination and never a source of files.**
All code, commits and pushes go to **`phazon2/Devpost-Hackaton`** on the designated branch.
Never copy its files into this repo, never commit its contents here, never push to it.

Where the two disagree, `hack-template/CLAUDE.md` wins on *how to work* (environment, evidence, credentials,
blockers, deploy); this file wins on *what Doorman is* (product, rubric, API facts, scope).

---

## 0. The situation

Building **Doorman** for the **DevNetwork [API + Cloud + AI] Hackathon 2026** on Devpost, targeting the
**name.com Domain API Challenge**.

**Deadline: Thursday 3 September 2026, 10:00 AM PDT (17:00 UTC).** Late submissions are not accepted.
Projects cannot be edited after that instant.

> **Re-derive days remaining from today's actual date at the start of every session. Run `date -u`.**
> Never carry a duration forward from a previous session or from a document. This has caused a real
> failure before: a plan written on one date was executed days later against its original day count.

**Builder:** Diego Radrigan. Solo. Based in Chile. Submitting **online only** — he will not attend the
onsite event in Santa Clara.

**Capacity is the binding constraint.** Under **2 hours of laptop time per day**, and a second hackathon is
running in parallel. Total realistic budget is **≈20–25 hands-on hours** including the demo video, README and
submission page. Scope every decision against that number. **When in doubt, cut.**

**Phone-first.** Browser logins, OAuth flows, payment steps, DNS propagation checks and any visual
verification are laptop-bound. Batch them into single sessions; do not sprinkle them across days.

**Prize being competed for:** name.com Domain API Challenge — 1st place $1,500 Amazon gift card, 2nd place
$500. Sponsor contact: `daisy.edwards@identity.digital`.

**Why this track:** across ~230 enumerated submissions from three prior DevNetwork events (API+Cloud+Data
2025, AI+ML 2026, DeveloperWeek 2026), **zero** touched domains, DNS, or registration. It is the emptiest
funded lane in this event family, and its rubric is unusually explicit — effectively a build checklist rather
than a taste judgement.

---

## 1. What Doorman is

> **Your suppliers don't have a company domain. So give them one of yours.**

That sentence is the pitch. It appears **verbatim** in the README header, the cover image, the video's first
and last frames, the Devpost short description, the repo description, and the app subtitle.
**Do not paraphrase it anywhere.** See §9 for the eight-place consistency check.

### The problem

Small businesses buy from suppliers who have no company domain and no company email. The bakery messages from
someone's personal WhatsApp. The dairy supplier writes invoices by hand. So when a fake invoice arrives from a
lookalike domain with a logo and a new bank account, **it looks more legitimate than the real supplier** — and
whoever is at the receiving door, often someone reassigned there that morning, has nothing to check against.
The current control is "I recognise him," and it dies the moment the regular person is off sick. This is
business email compromise, the most expensive fraud category small businesses actually suffer.

### The inversion

Stop asking small suppliers to prove who they are — they own nothing on the internet. **The buyer issues the
identity instead.**

The buyer owns one anchor domain. For each supplier onboarded, Doorman mints an identity for that supplier
**on the buyer's domain**. The supplier changes nothing about how they work: mail still lands in the Gmail or
phone-linked inbox they already read.

The rule a new person at the receiving door learns in ten seconds:

> **"If it didn't come through our address, it isn't them."**

### The demo moment — eight seconds, no narration

Onboarding a supplier is creating a forwarding. Firing a supplier is deleting one.
**Send a message to the alias → it arrives. Click revoke. Send again → it bounces.**

Revocation today is a note in a WhatsApp group. Here it is a DNS operation with a receipt.
**Everything else in the build exists to make that eight seconds credible.**

---

## 2. The rubric — this is what is actually scored

name.com publishes its criteria. Build directly against them, in this order of weight:

1. **API integration depth** — "combining multiple endpoints" is explicitly preferred over a single
   surface-level call. Depth is criterion #1. **Six endpoint groups is the target.**
2. **Creativity / originality** — unexpected applications favoured.
3. **Technical execution** — including **edge-case handling, called out by name**.
4. **Real-world viability.**
5. **Presentation / demo quality** showing the integration in action.

They also require the name.com API be **"functionally central to what they ship."** In Doorman it is: the
identity *is* the forwarding record. Delete the record, the identity is gone. There is no database-only
version of this product. Say that sentence in the README and in the video.

---

## 3. name.com CORE API — verified facts

**Do not rely on memory for anything below.** Confirm against the live docs and the live sandbox before
building on it. These values were correct when written and are cheap to re-check.

| Fact | Value |
|---|---|
| Production base | `https://api.name.com` |
| **Sandbox base** | `https://api.dev.name.com` ← **build against this exclusively** |
| Version | CORE API v1, path-versioned (`/core/v1/...`), released June 2025. Legacy v4 still exists; ignore it. |
| Auth | HTTP Basic: username + API token |
| **Sandbox auth quirk** | **Append `-test` to your username** and use the sandbox token |
| Rate limits | **20 req/sec, 3,000 req/hour.** `429` on breach. |
| Account requirement | **Two-factor authentication must be DISABLED** on the account. Use a throwaway account, never a personal one. |
| Token creation | Log in → user icon → Settings → Security → API Tokens → Create API Token → accept the API Access Agreement. Issues a **production token and a test token in the same step**. |
| **Path quirk** | **Do not URL-encode the colon** in endpoints like `POST /core/v1/domains:checkAvailability` |
| Sandbox note | Domains must be **created in the sandbox** before they can be used |

**Resource groups:** Hello · Account Info · Accounts · Domains · DNS · DNSSEC · Email Forwardings ·
URL Forwardings · Vanity Nameservers · Transfers · Orders · Webhook Notifications

**What the API does NOT do — do not design around these:** no WHOIS/RDAP intelligence, no trademark
screening, no valuation or appraisal, no aftermarket/premium marketplace, no hosting.

> **Money warning.** Registering a real domain **in production** draws on account credit or a default payment
> profile. Everything happens in sandbox. **No production registration, ever.** If any core operation appears
> to require real money, redesign around it rather than spending.

**Docs:**
- https://docs.name.com/api/v1/overview
- https://docs.name.com/coreapi/namecom.api
- https://www.name.com/support/articles/360007597874-signing-up-for-api-access

---

## 4. The six endpoint groups Doorman uses, and what each does

| Group | Role in Doorman |
|---|---|
| **Domains** (search / checkAvailability / register) | Onboarding: acquire the anchor domain, in sandbox |
| **Email Forwardings** | `lacteos-riquelme@midespensa.cl` → forwards to whatever inbox the supplier already reads. **This is the identity.** |
| **URL Forwardings** | A short, sayable address printed on the delivery slip → the supplier's public card |
| **DNS Records** | Publishes the binding nobody ever writes down: alias ↔ legal entity ↔ tax ID (RUT) ↔ trade name |
| **Webhook Notifications** | Domain expiry / transfer events — **every issued identity dies if the anchor domain dies** |
| **Account Info / Hello** | Auth and credit preflight, surfaced as a **real health check**, not a smoke test |

Hitting all six is criterion #1. **Do not stop at three because it works.**

---

## 5. Working rules — these are non-negotiable

These come from four logged post-mortems of real hackathon runs. Each one cost something. Obey them literally.

### Verification

- **Test the exact operation, against the exact target, with the exact credential you will use.**
  "Can I create an email forwarding on this sandbox domain with this test token" is a test.
  "Can I reach name.com" is a mood.
- **A read passing does not license a write.** Staging ≠ production. Public ≠ private. List ≠ create.
  Local ≠ deployed. `GET` ≠ `POST`.
- **The ninety-second rule.** If checking takes under two minutes and being wrong costs over an hour,
  checking is mandatory and is not a delay.
- **Verify a claim at the moment you write it**, not in an end-of-week audit. An unverified claim is a
  commitment; auditing it later only measures how long you were wrong.
- **A second look at the same source is not a second check.** A second check reaches the same fact by a
  different path.
- **Before asserting state, read it from whatever owns it** — and when you can't, name the proxy in the same
  breath as the claim.
- **Every write needs a read-back the writer does not control.** After creating a forwarding, *list*
  forwardings from the API and confirm it is there. **Do not trust the 201.**

### Scope and time

- **Order work by reversibility, not urgency.**
- **Two-hour cap on any unforeseeable integration failure.** Then cut it, stub it for the demo, or ship
  without it. **Log which.**
- **Two failed attempts on the same error → fresh context or a minimal reproduction.** Read the diff and the
  test result, never the explanation.
- **Reserve the last 1.5–2 days for packaging.** The gap between "technical-functional" and
  "submission-complete" is 60–80% of total work. Packaging has a slot; **do not raid it**.

### Security — there is outstanding debt from prior runs; do not add to it

- **Keys and tokens never enter chat.** They live in `.env`, which is gitignored from commit one.
- **Never run commands that print remotes, environment values or config.** Scrubbing does not un-print.
- **Rotating a key does not close an open endpoint.** Do not ship unauthenticated write endpoints.
- Never commit a shared sponsor/campaign credential to a public repo.

### Judging surfaces

- **Any defect on a surface a judge will look at is not cosmetic.** Judge severity from the live app, never
  from the diff.
- **Diff the demo build against deployed before every take.** A local fix silently converts a known bug into
  an unknown one.
- **Benchmark until it breaks, then publish the breaking point.** A ceiling you found and stated is
  credibility; one a judge finds is a defect.
- **Caveats live in the repo, not the pitch.** The pitch surface holds one claim, stated plainly. But the
  caveat must actually exist and be findable.
- **Deliverables live where the user can reach them.** A sandbox container is scratch space, never storage.
  **Push to the repo.**

---

## 6. Two things that must exist in the build

Both are cheap and both have independently scored at comparable events.

### Refusal architecture

At least **three** places where Doorman **declines rather than guesses**, each stating why in **one plain
sentence on screen** — not a `400` in a log:

1. Refuses to mint an alias colliding with a **reserved address** (`admin@`, `postmaster@`, `abuse@`).
2. Refuses to issue an identity on an **anchor domain expiring inside the alias's stated lifetime** — the
   identity would outlive its own foundation.
3. Refuses to **auto-merge two suppliers** whose trade names match but whose tax IDs differ.

Two judges at a comparable event independently praised a demonstrated refusal in a winning project. It is a
threshold check and an if-statement. It scores because it demonstrates a **negative capability**, in a field
where everyone else only shows things working.

### CI receipt architecture

A machine-written receipt **committed beside the script that produced it**, so the evidence audits itself:

- `scripts/probe.ts` → `ci/probe.json` — the Gate 0 boundary probe
- `scripts/edge-cases.ts` → `ci/edge-cases.json` — every edge case, with observed result

Every receipt opens with this header, **verbatim**:

> `"Records what this run observed, not what the tests claim."`

Publishing the script exposes your own false claims before a judge does. **That is the point.**
Publish failures too. A failure you found and stated is credibility.

---

## 7. Default stack

Chosen to minimise toolchain time, not to be impressive. **Change it only for a concrete reason.**

- **Node 20 + TypeScript**
- **Hono** (or Express) — one service, no framework ceremony
- **SQLite via `better-sqlite3`** — `suppliers`, `identities`, `events`
- **Server-rendered HTML + a little vanilla JS.** No React, no build step, no CSS framework install.
  A build step you have to debug at 1am is a day you don't have.
- Deploy to **Railway or Fly.io** (persistent disk for SQLite).
  A **public URL is required** for the name.com webhook receiver.

> **Do not conclude a public URL is impossible because the container cannot reach the provider's API.**
> Git-triggered deploy needs **zero container egress**: push to GitHub → the provider watches the repo →
> it builds on its own infra → public URL. That URL is also the webhook receiver. The chain runs entirely
> outside this container. The only human step is connecting the repo to the provider **once**, in a browser.
> This mistake has already been made once in this project — a blocked `api.railway.app` was misread as
> "deployment is impossible from here."

Layout:

```
src/namecom.ts     thin typed API client
src/db.ts          sqlite schema + queries
src/identity.ts    mint() / revoke(), each with an API read-back
src/webhooks.ts    name.com webhook receiver
src/server.ts      routes + server-rendered pages
scripts/probe.ts   → ci/probe.json
scripts/edge-cases.ts → ci/edge-cases.json
docs/ARCHITECTURE.md
docs/EDGE-CASES.md
.env               NEVER COMMITTED
```

---

## 8. Explicitly not doing

Each was considered and rejected on evidence. **Do not add these.**

- **Xano** — 5-day platform learning curve, worst prize-per-hour on the board.
- **Perfect Corp** — RSA auth, presigned uploads, polling, and mandatory public image hosting. ~4 days.
- **Foxit / Nutrient / Doctavian** — the three-sponsor document pile-up. Three independent AI agents given
  only this hackathon's brief converged on the same document-stack architecture; it is the modal answer and it
  will be the most crowded lane at the event.
- **The $12,500 Overall prize** — the top 5 are phoned at 1:00 PM and must demo onsite in Santa Clara at
  2:30 PM on Sept 3. Not attending, so not competing.
- **A React SPA, a design system, auth/multi-tenancy, or a mobile app.** None is scored. All cost days.

**One optional stretch, and only if days 1–8 run clean:** an *inverted fraud heuristic* — for a supplier who
has always had no internet identity, a three-week-old domain with mail configured is a **high**-risk signal,
not a low one, which is the opposite of how every fraud tool scores it. One SerpApi call per supplier adds a
second sponsor track. ~2 hours. **It must not touch the spine before day 8.**

---

## 9. Submission requirements

- Project name + one-line pitch (**the sentence in §1, verbatim**)
- **Public repository** with setup instructions that work from a clean clone
- **Demo video, 2–4 minutes**
- Written project description
- **On the Devpost submission form, explicitly select the name.com Domain API Challenge.**
  Missing the checkbox means you are simply not judged. **Read the form on day 1, not on deadline day.**
- **Tag every genuinely-used component.** Field median is 6 tags. A prior submission shipped with 1 and it
  cost discoverability.
- **Submit a complete placeholder 24 hours early, then edit.** Projects cannot be edited after the deadline.

**Consistency check before submitting — the same exact pitch string in all eight places:**

1. README header  2. cover image tagline  3. video opening frame  4. video closing frame
5. Devpost short description  6. repo description  7. app subtitle  8. any social post

Judges read 4–6 artifacts per project. Inconsistency reads as "not real" even when no judge can articulate why.

---

## 10. Working style for this repo

- **Do not ask clarifying questions.** Proceed with reasonable defaults and **state the assumption in one
  line.**
- **Report back, every session:** what you changed · what you verified and **how** · what you assumed ·
  **what is still unverified.**
- **Split strategy from debugging.** If an error takes more than two attempts, open a minimal reproduction
  rather than continuing in the same thread.
- **Commit often with real messages.** The commit log is part of the "Progress" story a judge may read.
- Work the plan in `BUILD-SPEC.md`. **Gate 0 blocks all product code.**
