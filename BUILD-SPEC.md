# BUILD-SPEC.md — Doorman

Execution plan with acceptance criteria. **Read `CLAUDE.md` first.**
**Run `date -u` and re-derive days remaining before starting any session.**

**Deadline: Thu 3 Sep 2026, 10:00 AM PDT = 17:00 UTC.** Budget **≈20–25 hands-on hours total**, at under
2 h/day, **including packaging**.

### How to read the day numbers

Day numbers are **work slots, not calendar dates**. This spec was authored with 14 slots. At the time of
writing (23 Aug 2026, ~21:30 UTC) there were **~10.8 calendar days** to the deadline — so the slots were
already tighter than 1:1 and only get tighter. **Do not trust that number**: run `date -u`, compute
`(2026-09-03T17:00:00Z − now)`, and map slots to real days yourself at the start of every session.

If slots exceed remaining days, compress in this order — **never by borrowing from packaging**:

| Remaining days | Compression |
|---|---|
| 11+ | Run as written. |
| 9–10 | Merge slots 10–11 (README) into one day. Merge slot 9 (refusals + one screen) into slot 8. |
| 7–8 | Above, plus: fold slot 6 into 5, and apply cut-order items 1–2. |
| 5–6 | Above, plus apply cut-order items 3–4. Spine + refusals + depth table + video only. |
| <5 | Spine, three refusals, integration-depth table, README, video, submit. Nothing else. |

**Packaging (slots 12–13) and submit-early (slot 14) are never compressed.** They are the last ~2.5 days
of real calendar time, whatever the slot numbering says.

---

## GATE 0 — Before writing any product code

**~30–45 min · laptop · one batched session.**

Nothing below this line starts until all five are resolved. Each can invalidate the plan and each is cheap.
**This is the ninety-second rule applied to the whole project.**

| # | Check | Pass condition | If it fails |
|---|---|---|---|
| **0.1** | Register on Devpost and **open the actual submission form**. | You have *seen* the form and confirmed there is a selectable **name.com Domain API Challenge** checkbox, and you know every required field. | If the challenge cannot be selected, **email the organisers immediately**. Missing this means you are not judged at all. |
| **0.2** | Create a **throwaway** name.com account with **2FA disabled**. Settings → Security → API Tokens → Create API Token. | You hold **both** a production token and a test token. Both are in `.env`, which is **already gitignored**. | No workaround. **Blocking.** |
| **0.3** | **Prize form.** Email `daisy.edwards@identity.digital`: *"Is the $1,500 / $500 prize a transferable Amazon gift card, or name.com account credit?"* | Answer received, **or** sent and awaiting. | Account credit is near-worthless to a Chilean solo dev. **If credit, reconsider the whole track before day 2.** |
| **0.4** | **Boundary probe** — the exact operation, exact credential, exact target. Against `https://api.dev.name.com` with the **`-test`** username: `GET /core/v1/hello` → create a sandbox domain → create **one email forwarding** on it → **list** forwardings and confirm it is there → **delete** it → **list again** and confirm it is gone. | The full **mint → read-back → revoke → read-back** cycle completes in sandbox. | If email forwardings are unavailable in sandbox, **the product does not exist as specified. Find out today, not on day 9.** Fallback: URL forwardings + DNS records as the identity, alias as a routing record. |
| **0.5** | Can the **entire build** run in sandbox with **zero money spent**? | Confirmed. | If real registration is required for any core operation, **redesign to avoid it. Never spend.** |

**Deliverable:** write the observed results to `ci/probe.json` via `scripts/probe.ts`, with the header,
verbatim:

> `"Records what this run observed, not what the tests claim."`

**Commit the script next to the receipt.** `scripts/probe.ts` must be re-runnable by a judge with their own
`.env`.

`ci/probe.json` shape:

```json
{
  "header": "Records what this run observed, not what the tests claim.",
  "ranAtUtc": "<ISO>",
  "base": "https://api.dev.name.com",
  "checks": [
    { "id": "0.4.hello",         "op": "GET /core/v1/hello",                        "status": "pass|fail", "httpStatus": 0, "observed": "" },
    { "id": "0.4.domain.create", "op": "POST /core/v1/domains",                     "status": "", "httpStatus": 0, "observed": "" },
    { "id": "0.4.fwd.create",    "op": "POST /core/v1/domains/{d}/email/forwardings","status": "", "httpStatus": 0, "observed": "" },
    { "id": "0.4.fwd.readback",  "op": "GET  /core/v1/domains/{d}/email/forwardings","status": "", "httpStatus": 0, "observed": "" },
    { "id": "0.4.fwd.delete",    "op": "DELETE .../forwardings/{alias}",             "status": "", "httpStatus": 0, "observed": "" },
    { "id": "0.4.fwd.readback2", "op": "GET  .../forwardings (absence)",             "status": "", "httpStatus": 0, "observed": "" }
  ],
  "unverified": []
}
```

**Do not proceed past a failed gate by assuming it will work later.** Record failures in `unverified[]` and
say so out loud in the session report.

**Assumption to state if 0.1/0.3 are blocked on a human:** proceed with 0.2/0.4/0.5 (the technical gates) and
mark 0.1/0.3 as *awaiting reply* in the session report. Never mark them passed.

---

## DAYS 1–3 — The spine (~4–5 h)

**Build the eight seconds first. Everything else is decoration on it.**

**Deliver:**

- `src/namecom.ts` — thin **typed** client. Real error types for `429` and `4xx`. **No retries yet.**
- `src/db.ts` — `suppliers`, `identities`, `events` tables. **Every mutation writes an `events` row:**
  what, when, which API call, what came back.
- `src/identity.ts` — `mint(supplier)` and `revoke(identityId)`, **each doing a read-back the writer does not
  control** (list from the API, confirm state) before returning success. **Do not trust the 201.**
- Minimal **server-rendered** page: supplier list, "Add supplier" form, "Revoke" button.
- **Deployed to a public URL.**

**Acceptance:** on the **deployed** app — add a supplier → mail to the alias **arrives** at the destination
inbox → click Revoke → mail to the same alias **bounces**. End to end, **no local-only steps**.

**Also on day 1 — lock these and never revisit:**

- The **name** (`Doorman`) and the **pitch sentence**. Renaming later cascades into repo URL, deploy URL,
  video, cover image and every social post. Change it now or not at all.
- **Read the Devpost submission form** (Gate 0.1 confirms it exists; day 1 reads every field).
- Create `docs/ARCHITECTURE.md` and `docs/EDGE-CASES.md` as stubs so days 4–8 fill rather than start them.

---

## DAYS 4–6 — Depth (~4 h)

**This is criterion #1 and it is where the track is won. Target all six endpoint groups.**

**Deliver:**

- **URL Forwardings** — a short sayable address per supplier → their public card page.
  Print it on the mock delivery slip used in the video.
- **DNS Records** — publish the binding: `alias ↔ legal entity name ↔ tax ID (RUT) ↔ trade name`.
  Make it **resolvable** and show `dig` returning it in the video.
- **Webhook Notifications** — register a receiver at `src/webhooks.ts`. Handle **domain expiry** and
  **transfer** events. Every issued identity dies if the anchor domain dies — **that connection must be
  visible in the UI, not just logged.**
- **Account Info / Hello** — a **real health check page**: auth status, credit, anchor-domain expiry date,
  count of live identities. Not a smoke test — **a dashboard tile**.
- **Domains** (search / checkAvailability / register) — the anchor-domain onboarding flow.
  Remember: **do not URL-encode the colon** in `domains:checkAvailability`.

**Acceptance:** `docs/ARCHITECTURE.md` contains a table mapping **each of the six endpoint groups** to the
**exact product behaviour** it powers, **with the endpoint path**. A judge should be able to verify
integration depth **without reading code**.

| Endpoint group | Endpoint path(s) | Product behaviour | Where to see it |
|---|---|---|---|
| … | … | … | … |

---

## DAYS 7–8 — Edge cases (~3 h)

**Criterion #3 names edge-case handling explicitly.** Each of these gets **an implementation**, **a test in
`scripts/edge-cases.ts`**, and **a row in `docs/EDGE-CASES.md`**.

| # | Case | Required behaviour |
|---|---|---|
| 1 | Two suppliers share a trade name | Collision resolved by **tax-ID-suffixed alias**. **Never silently overwrite.** |
| 2 | Supplier changes their personal inbox | **Alias unchanged, destination updated.** Nothing already printed becomes wrong. *This is the point of the design — say so, on screen and in the README.* |
| 3 | Supplier fired mid-week | Alias deleted; **the bounce is the proof**. Event row records who revoked and when. |
| 4 | Alias minted while the anchor domain is near expiry | **Refuse.** The identity would outlive its foundation. **State why.** |
| 5 | Reserved-address collision (`admin@`, `postmaster@`, `abuse@`) | **Refuse, do not mangle.** |
| 6 | Rate limit — 20 req/sec, 3,000/hr | Batch onboarding with **backoff**. **Demonstrate it working on a batch of 30**, don't just claim it. |
| 7 | Domain transfer initiated | Every issued identity is at risk. **Alarm state in the UI**, not a log line. |
| 8 | Same trade name, **different tax ID** | **Refuse to merge.** Propose, require confirmation. |

**Acceptance:** `scripts/edge-cases.ts` runs **all eight against sandbox** and writes `ci/edge-cases.json`
with **observed results — including any that fail**. Same verbatim header as `probe.json`.

**Publish the failures.** A ceiling you found and stated is credibility; one a judge finds is a defect.

`ci/edge-cases.json` row shape: `{ "id": 1..8, "case": "", "expected": "", "observed": "", "status": "pass|fail|not-built", "httpStatus": 0, "ranAtUtc": "" }`

---

## DAY 9 — Refusal architecture + the one screen (~2 h)

Cases **4, 5 and 8** above are the refusals. Make each one **visible in the product, in one plain sentence,
on screen** — not a `400` in a log. Suggested copy (short, no jargon, no error codes):

- *"We won't issue this identity: the domain it lives on expires before the identity is meant to."*
- *"`admin@` is reserved for the domain itself. Pick another alias — we won't rename it for you."*
- *"Two suppliers, same trade name, different tax ID. We won't merge them. Confirm which one this is."*

Then: **one screen, everything pre-interpreted.** Supplier list · alias · status · revoke.
**No logs, no traces, no agent diagrams, no pipeline visualisations.** If another team shows machinery and
you show one clean screen where everything is already interpreted, **you win that comparison**.

**Acceptance:** all three refusals are reachable **on the deployed app** by a judge doing an obvious thing,
and each shows its sentence. Screenshot each into the README.

---

## DAYS 10–11 — README as the product (~3 h)

**Mentors and judges frequently do not run code. The repo is the product.**

README structure, in this order:

1. **Banner / cover image** carrying the pitch sentence
2. **The pitch sentence, bold, first line of text** — verbatim
3. **The problem in one paragraph** — with a **real number** for BEC losses, **verified with a citation at
   the moment you write it** (not from memory)
4. **The eight-second demo, as a GIF** — arrives → revoke → bounces
5. **Integration depth table** — six endpoint groups → six product behaviours → six endpoint paths
6. **Edge cases table**, linking to `ci/edge-cases.json`
7. **Architecture** — how an identity is minted, read back, and revoked
8. **Setup instructions that actually work from a clean clone** (test them by cloning into a fresh directory)
9. **"Hackathon Context"** section naming the track and the specific award being competed for
10. **Limits and caveats** — stated plainly, **in the repo, not in the pitch**

---

## DAYS 12–13 — Packaging (protected; do not raid) (~4–5 h)

**Storyboard before recording.** A planned video is roughly 10× faster to produce than an improvised one.

| Beat | Time | Content |
|---|---|---|
| 1. Hook | 0:00–0:15 | **One named supplier, one fake invoice, one specific dollar amount.** Not "a user" and "some data." |
| 2. Setup | 0:15–0:40 | Onboarding a supplier is creating one forwarding. **Don't linger.** |
| 3. **THE WOW** | 0:40–1:30 | Mail arrives → revoke → mail **bounces**. Longest beat. **Schedule two full seconds of silence at the bounce.** Most demo videos never stop talking. |
| 4. Depth + refusal | 1:30–2:20 | `dig` returning the DNS binding; the expiry refusal **stating why**; the batch hitting the rate limit and backing off. |
| 5. Close | 2:20–2:40 | **Pitch sentence repeated verbatim**, live URL on screen. |

Target **2–4 minutes** per the sponsor requirement.

**Do:** record in his **own voice, Spanish with English captions** — this read as the most authentic asset in
a prior submission. **Mark stage directions separately from spoken words** so voiceover records independently
of screen capture.

**Pre-flight checklist:** laptop charged · browser zoom at **exactly 100%** · notifications off · seed data
re-run 30 minutes before · backup recording on a second device · mobile hotspot as backup internet ·
**diff the demo build against deployed before every take**.

**Production value is not the differentiator.** A person reading a script and walking through the live app
beats cinematics. What is polished is **the writing**.

---

## DAY 14 — Submit early (~1 h)

**Submit a complete placeholder 24 hours before the deadline, then edit.** Projects cannot be edited after
10:00 AM PDT, 3 Sept 2026.

- [ ] **Select the name.com Domain API Challenge checkbox.**
- [ ] **Tag every genuinely-used component.** Field median is 6.
- [ ] Run the **eight-place consistency check** on the pitch string (`CLAUDE.md` §9).
- [ ] Public repo URL, live app URL, video URL all resolve **from a logged-out browser**.
- [ ] Confirm the deadline in local time. **10:00 AM PDT = 17:00 UTC.**
- [ ] **Do not edit during judging.** One submission, one description, one outcome, one clean observation.

---

## Cut order, if behind

**Cut from the bottom. Never cut from the top.**

1. **The SerpApi stretch** — first to go, always.
2. **Vanity nameservers / DNSSEC depth.**
3. **Edge cases 6 and 7** (rate-limit batching, transfer alarm) — keep them **documented as known-unbuilt in
   the README** rather than silently absent.
4. **The public supplier card page** — URL forwarding can point at a static page.

**Never cut:** the **mint → revoke → bounce spine**, the **three refusals**, the **integration-depth table**,
or **the video**.

---

## Pre-submission audit — paste this at any model before submitting

```
You are auditing a hackathon submission for defects that lose points. Be hostile.
Do not compliment anything. Report only findings.

Context: DevNetwork [API + Cloud + AI] Hackathon 2026, name.com Domain API
Challenge. Rubric, in weight order: (1) API integration depth, explicitly
"combining multiple endpoints"; (2) creativity/originality; (3) technical
execution including edge-case handling; (4) real-world viability; (5) demo
quality. The sponsor also requires the name.com API be "functionally central to
what they ship."

Inputs: the public repo, the live URL, the demo video, the Devpost page.

Check each and answer with evidence, not opinion:

1. PITCH CONSISTENCY. Is the exact string "Your suppliers don't have a company
   domain. So give them one of yours." present verbatim in all eight places:
   README header, cover image, video opening frame, video closing frame, Devpost
   short description, repo description, app subtitle, social post? List every
   place it is missing or paraphrased.

2. INTEGRATION DEPTH. How many distinct name.com endpoint GROUPS are actually
   called by shipped code (not mentioned in docs)? Name the file and line for
   each. If a group appears in the README table but has no live call site, that
   is a false claim — flag it.

3. FALSE CLAIMS. List every claim in the README, video or Devpost description
   that the repo does not substantiate. Treat "we handle X" with no code path as
   a false claim. Treat a receipt whose script does not produce it as a false
   claim.

4. THE SPINE. Can a judge, from a logged-out browser and the README alone,
   reproduce: mail arrives -> revoke -> mail bounces? What is the first step
   that would stop them?

5. SETUP. Clone the repo mentally from scratch with only the README. Name the
   first command that fails or the first undeclared prerequisite.

6. REFUSALS. Are all three refusals reachable in the live app by an obvious
   action? Does each state its reason in one plain sentence on screen, rather
   than returning an error code?

7. RECEIPTS. Do ci/probe.json and ci/edge-cases.json each carry the header
   "Records what this run observed, not what the tests claim."? Does each sit
   beside the script that produced it? Do they report any failures, or do they
   suspiciously report all-pass?

8. SUBMISSION MECHANICS. Is the name.com challenge checkbox selected? How many
   tags? (Median is 6.) Do the repo, live and video URLs resolve for a logged-out
   visitor?

9. SECRETS. Search the repo for tokens, .env contents, API usernames, or a
   committed .env. Report any hit with file and line.

10. THE SINGLE WORST DEFECT. Name the one thing most likely to cost the prize,
    and the smallest change that fixes it.

End with a numbered fix list ordered by (points at risk) / (minutes to fix).
```

---

## Kickoff prompt for a fresh Claude Code session

```
Read CLAUDE.md and BUILD-SPEC.md in full before doing anything.

Run `date -u` and tell me how many days remain until the deadline
(3 September 2026, 10:00 AM PDT).

Then execute GATE 0 in BUILD-SPEC.md. Do not write any product code until
every gate item is resolved. For 0.4, run the exact operation against the
exact target with the exact credential — a passing GET does not license a
POST. Write the observed results to ci/probe.json via scripts/probe.ts and
commit the script beside the receipt.

Do not ask me clarifying questions. Proceed with reasonable defaults and
state each assumption in one line.

Report back: what you ran, what you observed, what passed, what failed,
and what is still unverified.
```
