/**
 * Exercises src/db.ts and src/identity.ts against the LOCAL MOCK.
 *
 * READ THIS BEFORE QUOTING ANY OUTPUT OF THIS SCRIPT.
 *
 * The mock encodes our own assumptions about name.com. Every result here is
 * MOCK-DERIVED. It demonstrates that our logic behaves as intended given those
 * assumptions; it is evidence about Doorman's code and about nothing else.
 * It is not, and can never become, Gate 0.4. That is `scripts/probe.ts` against
 * `https://api.dev.name.com` with a real token, and it has not been run.
 *
 * The receipt is written to `ci/exercise.mock.json` — deliberately NOT
 * `ci/probe.json` and NOT `ci/edge-cases.json`, both of which must be produced
 * against the sandbox or not at all.
 *
 *   npm run exercise:mock
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createMockServer } from "../src/mock/server.ts";
import { NamecomClient } from "../src/namecom.ts";
import { DoormanDb } from "../src/db.ts";
import {
  mint, revoke, updateDestination, onboardSupplier,
  assertAnchorOutlivesIdentity, DEFAULT_IDENTITY_LIFETIME_DAYS,
  Refusal, ReadBackFailure, type IdentityDeps,
} from "../src/identity.ts";

const HEADER = "Records what this run observed, not what the tests claim.";
const ANCHOR = "midespensa.cl";      // seeded, expires in ~365 days
const EXPIRING = "caducando.cl";     // seeded, expires in 12 days

interface Case {
  id: string;
  what: string;
  expected: string;
  observed: string;
  status: "pass" | "fail";
}
const cases: Case[] = [];

function record(id: string, what: string, expected: string, observed: string, ok: boolean) {
  cases.push({ id, what, expected, observed, status: ok ? "pass" : "fail" });
  console.log(`  ${ok ? "pass" : "FAIL"}  ${id}  ${observed}`);
}

async function check(
  id: string,
  what: string,
  expected: string,
  fn: () => Promise<string> | string,
): Promise<void> {
  try {
    record(id, what, expected, await fn(), true);
  } catch (err: any) {
    record(id, what, expected, `threw ${err?.name}: ${err?.message}`, false);
  }
}

/** Asserts a Refusal with the given code, and returns its on-screen sentence. */
async function expectRefusal(
  id: string,
  what: string,
  code: string,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  const expected = `Refusal(${code}) with a plain sentence for the screen`;
  try {
    await fn();
    record(id, what, expected, "NO refusal was raised — the operation was allowed", false);
  } catch (err: any) {
    if (err instanceof Refusal && err.code === code) {
      record(id, what, expected, `refused: "${err.sentence}"`, true);
    } else {
      record(id, what, expected, `wrong error ${err?.name}: ${err?.message}`, false);
    }
  }
}

async function main(): Promise<void> {
  const server = createMockServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const dbFile = join(tmpdir(), `doorman-exercise-${Date.now().toString(36)}.db`);
  const db = new DoormanDb(dbFile);
  const client = new NamecomClient({ base, username: "demo-test", token: "mock-token" });
  const deps: IdentityDeps = { db, client, domain: ANCHOR, actor: "diego" };

  console.log(`exercising against MOCK ${base} (NOT name.com)\n`);

  // ---------------------------------------------------------------- spine
  const lacteos = onboardSupplier(deps, {
    legalName: "Comercial Riquelme Limitada",
    tradeName: "Lácteos Riquelme",
    taxId: "76.543.210-9",
    destination: "riquelme.lacteos@gmail.com",
  });

  let mintedId = 0;
  await check(
    "spine.mint",
    "mint(): create forwarding, then LIST and confirm present",
    "identity live, alias derived from the trade name, read-back confirms presence",
    async () => {
      const r = await mint(deps, lacteos.id);
      mintedId = r.identity.id;
      return `${r.address} -> ${r.identity.destination}; read-back present=${r.readBack.present} destinationMatches=${r.readBack.destinationMatches}`;
    },
  );

  await check(
    "spine.mint.event",
    "every mutation writes an events row",
    "an identity.mint event carrying the API method, path and status",
    () => {
      const evs = db.eventsFor("identity", mintedId);
      const m = evs.find((e) => e.action === "identity.mint");
      if (!m) throw new Error("no identity.mint event row");
      if (!m.apiPath || m.apiStatus === null) throw new Error("event has no API trace");
      return `${evs.length} event(s); mint recorded ${m.apiMethod} ${m.apiPath} -> ${m.apiStatus}`;
    },
  );

  await check(
    "spine.revoke",
    "revoke(): delete forwarding, then LIST and confirm absent",
    "identity revoked only after the API list no longer contains it",
    async () => {
      const r = await revoke(deps, mintedId);
      const after = db.getIdentity(mintedId)!;
      const listed = await client.listEmailForwardings(ANCHOR);
      const present = (listed.emailForwarding ?? []).some((f) => f.emailBox === after.alias);
      if (present) throw new Error("alias still present at the API after revoke");
      return `${r.address} status=${after.status} revokedAt=${after.revokedAt ? "set" : "null"}; absent from API list`;
    },
  );

  // ------------------------------------------ read-back is load-bearing
  // Negative control: a client that fakes a 201 for the create and never
  // actually writes. If mint() still reports success, the read-back is
  // decorative and the whole evidence story is worthless.
  await check(
    "spine.readback.negative-control",
    "mint() against an API that CLAIMS 201 but did not create the forwarding",
    "ReadBackFailure — the 201 is not believed, nothing is recorded as live",
    async () => {
      const lying = new NamecomClient({
        base,
        username: "demo-test",
        token: "mock-token",
        fetchImpl: async (input: any, init: any) => {
          const url = String(input);
          if (init?.method === "POST" && url.endsWith("/email/forwarding")) {
            return new Response(JSON.stringify({ emailBox: "ghost", emailTo: "x@y.z" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          return fetch(input, init);
        },
      });
      const ghostSupplier = onboardSupplier(deps, {
        legalName: "Fantasma SpA",
        tradeName: "Fantasma",
        taxId: "77.000.111-2",
        destination: "fantasma@gmail.com",
      });
      const before = db.listIdentities(ghostSupplier.id).length;
      try {
        await mint({ ...deps, client: lying }, ghostSupplier.id);
        throw new Error("mint() believed the 201 and returned success");
      } catch (err: any) {
        if (!(err instanceof ReadBackFailure)) throw err;
        const after = db.listIdentities(ghostSupplier.id).length;
        if (after !== before) throw new Error("an identity row was written despite the failed read-back");
        const failEv = db
          .eventsFor("supplier", ghostSupplier.id)
          .some((e) => e.action === "identity.mint.readback_failed");
        if (!failEv) throw new Error("no readback_failed event was recorded");
        return `ReadBackFailure raised, 0 rows written, failure recorded in events`;
      }
    },
  );

  // ------------------------------------------------------------ refusals
  await expectRefusal(
    "refusal.1.reserved-alias",
    "REFUSAL 1 — minting `admin@` on the anchor domain",
    "reserved-alias",
    async () => {
      const s = onboardSupplier(deps, {
        legalName: "Admin Ltda", tradeName: "Admin",
        taxId: "70.111.222-3", destination: "admin.persona@gmail.com",
      });
      return mint(deps, s.id);
    },
  );

  await expectRefusal(
    "refusal.2.anchor-expires-first",
    "REFUSAL 2 — a 365-day identity on a domain that expires in 12 days",
    "anchor-expires-first",
    async () => {
      const s = onboardSupplier(deps, {
        legalName: "Panificadora Ltda", tradeName: "Pan del Sur",
        taxId: "78.222.333-4", destination: "pandelsur@gmail.com",
      });
      return mint({ ...deps, domain: EXPIRING }, s.id, { lifetimeDays: 365 });
    },
  );

  await expectRefusal(
    "refusal.3.trade-name-tax-id-conflict",
    "REFUSAL 3 — same trade name, different tax ID",
    "trade-name-tax-id-conflict",
    () =>
      onboardSupplier(deps, {
        legalName: "Otra Sociedad SpA",
        tradeName: "Lácteos Riquelme",       // same trade name as the first supplier
        taxId: "99.888.777-6",               // different tax ID
        destination: "otro.riquelme@gmail.com",
      }),
  );

  await check(
    "refusal.3.confirmed",
    "the same conflict, once the buyer confirms they are different companies",
    "supplier created — Doorman proposes, the human decides",
    () => {
      const s = onboardSupplier(deps, {
        legalName: "Otra Sociedad SpA", tradeName: "Lácteos Riquelme",
        taxId: "99.888.777-6", destination: "otro.riquelme@gmail.com",
        confirmedDistinct: true,
      });
      return `supplier ${s.id} created with taxId ending ${s.taxId.slice(-4)}`;
    },
  );

  await check(
    "refusal.events",
    "each refusal is recorded in events, not swallowed",
    "one refusal.* event per refusal raised above",
    () => {
      const actions = db.listEvents(200).map((e) => e.action).filter((a) => a.startsWith("refusal."));
      const want = ["refusal.reserved-alias", "refusal.anchor-expires-first", "refusal.trade-name-tax-id-conflict"];
      const missing = want.filter((w) => !actions.includes(w));
      if (missing.length) throw new Error(`missing refusal events: ${missing.join(", ")}`);
      return `${actions.length} refusal event(s): ${[...new Set(actions)].join(", ")}`;
    },
  );

  await check(
    "refusal.2.boundary",
    "REFUSAL 2 — exactly where the refusal starts and stops",
    `a ${DEFAULT_IDENTITY_LIFETIME_DAYS}-day identity is refused at ${DEFAULT_IDENTITY_LIFETIME_DAYS - 1} days to expiry and allowed at ${DEFAULT_IDENTITY_LIFETIME_DAYS + 1}`,
    () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const at = (days: number) => new Date(now.getTime() + days * 864e5).toISOString();
      const life = DEFAULT_IDENTITY_LIFETIME_DAYS;
      let refusedAt = 0;
      try {
        assertAnchorOutlivesIdentity("x.cl", at(life - 1), life, now);
        throw new Error(`expiry at ${life - 1}d was allowed for a ${life}d identity`);
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        refusedAt = life - 1;
      }
      assertAnchorOutlivesIdentity("x.cl", at(life + 1), life, now);
      return `refused at ${refusedAt}d to expiry, allowed at ${life + 1}d; the boundary is the identity's own end date`;
    },
  );

  // ---------------------------------------------------------- edge case 1
  await check(
    "edge.1.alias-collision",
    "two suppliers, same trade name, both minted",
    "second alias suffixed with the tax ID; the first is never overwritten",
    async () => {
      const a = onboardSupplier(deps, {
        legalName: "Distribuidora Uno SpA", tradeName: "El Molino",
        taxId: "76.111.111-1", destination: "molino.uno@gmail.com",
      });
      const b = onboardSupplier(deps, {
        legalName: "Distribuidora Dos SpA", tradeName: "El Molino",
        taxId: "76.222.222-2", destination: "molino.dos@gmail.com",
        confirmedDistinct: true,
      });
      const ra = await mint(deps, a.id);
      const rb = await mint(deps, b.id);
      if (ra.address === rb.address) throw new Error("the two identities collided");
      const listed = await client.listEmailForwardings(ANCHOR);
      const boxes = (listed.emailForwarding ?? []).map((f) => f.emailBox);
      const bothLive = [ra, rb].every((r) => boxes.includes(r.identity.alias));
      if (!bothLive) throw new Error(`both aliases should be live at the API; saw ${boxes.join(",")}`);
      return `${ra.address} and ${rb.address} both live (suffixed=${rb.aliasWasSuffixed})`;
    },
  );

  // ---------------------------------------------------------- edge case 2
  await check(
    "edge.2.destination-change",
    "supplier changes the inbox they read",
    "alias unchanged, destination updated, read-back confirms the new destination",
    async () => {
      const s = onboardSupplier(deps, {
        legalName: "Frutas del Valle Ltda", tradeName: "Frutas del Valle",
        taxId: "76.333.444-5", destination: "valle.viejo@gmail.com",
      });
      const r = await mint(deps, s.id);
      const before = r.address;
      const upd = await updateDestination(deps, r.identity.id, "valle.nuevo@gmail.com");
      if (upd.address !== before) throw new Error(`alias changed: ${before} -> ${upd.address}`);
      const listed = await client.listEmailForwardings(ANCHOR);
      const f = (listed.emailForwarding ?? []).find((x) => x.emailBox === r.identity.alias);
      if (f?.emailTo !== "valle.nuevo@gmail.com") throw new Error(`API still forwards to ${f?.emailTo}`);
      return `${upd.address} unchanged; destination now valle.nuevo@gmail.com (confirmed by read-back)`;
    },
  );

  // ------------------------------------------------- the events invariant
  await check(
    "db.events.invariant",
    "no mutation without an events row",
    "suppliers + identity mints + revokes + destination changes all represented",
    () => {
      const evs = db.listEvents(500);
      const counts = new Map<string, number>();
      for (const e of evs) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
      const suppliers = db.listSuppliers().length;
      const created = counts.get("supplier.create") ?? 0;
      if (created !== suppliers) throw new Error(`${suppliers} suppliers but ${created} create events`);
      const mints = counts.get("identity.mint") ?? 0;
      const identities = db.listIdentities().length;
      if (mints !== identities) throw new Error(`${identities} identities but ${mints} mint events`);
      return `${evs.length} events total: ` +
        [...counts.entries()].map(([k, v]) => `${k}=${v}`).sort().join(" ");
    },
  );

  // ------------------------------------------------------------- receipt
  const failed = cases.filter((c) => c.status === "fail");
  const receipt = {
    header: HEADER,
    MOCK_DERIVED: true,
    warning:
      "EVERY result in this file was produced against a LOCAL MOCK of the name.com API " +
      "(src/mock/server.ts), not against name.com. The mock encodes our own assumptions, " +
      "so this receipt is evidence about Doorman's own logic and about nothing else. " +
      "It is NOT Gate 0.4 and can never become Gate 0.4.",
    ranAtUtc: new Date().toISOString(),
    base: "LOCAL MOCK — NOT NAME.COM",
    exercises: ["src/db.ts", "src/identity.ts", "CLAUDE.md §6 refusals 1-3"],
    cases,
    requestLog: client.log,
    unverified: [
      "Nothing here says an email forwarding can actually be created on api.dev.name.com. " +
        "Gate 0.4 has NOT been run: no name.com token exists in this environment.",
      "Endpoint paths in src/namecom.ts PATHS remain UNVERIFIED against the real API.",
      "Mail delivery is not exercised here and is not exercisable anywhere in this project: " +
        "name.com's sandbox stores DNS but never publishes it, so the MX records that would route " +
        "mail to an alias never become public. No message can arrive at an alias and none can bounce. " +
        "The spine is therefore proven by the API read-back (mint -> list -> revoke -> list), which " +
        "is real against the sandbox, and NOT by mail delivery. Doorman must never claim otherwise.",
      "The response SHAPES the read-backs depend on (emailForwarding[].emailBox / .emailTo) are " +
        "assumptions of the mock. If name.com names them differently, every read-back here is wrong.",
    ],
  };
  mkdirSync("ci", { recursive: true });
  writeFileSync("ci/exercise.mock.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(`\nwrote ci/exercise.mock.json — ${cases.length - failed.length}/${cases.length} pass`);

  db.close();
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  await new Promise<void>((r) => server.close(() => r()));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
