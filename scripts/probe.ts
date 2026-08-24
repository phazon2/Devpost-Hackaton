/**
 * GATE 0.4 — the boundary probe.
 *
 * Runs the exact operations, against the exact target, with the exact
 * credential: hello -> create sandbox domain -> create ONE email forwarding ->
 * list and confirm present -> delete -> list and confirm absent.
 *
 * Writes ci/probe.json. Records what it OBSERVED, including failures.
 *
 * Usage:
 *   npm run probe        # reads .env, expects NAMECOM_BASE=https://api.dev.name.com
 *   npm run probe:mock   # against the local mock; receipt is stamped mock and
 *                        # is NOT evidence of anything about name.com
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { NamecomClient, NAMECOM_SANDBOX_BASE, NAMECOM_PRODUCTION_BASE } from "../src/namecom.ts";

const HEADER = "Records what this run observed, not what the tests claim.";

interface Check {
  id: string;
  op: string;
  status: "pass" | "fail" | "skipped";
  httpStatus: number | null;
  observed: string;
}

function env(name: string): string {
  return process.env[name] ?? "";
}

/** Reads .env without a dependency, and without printing any value. */
function loadDotEnv(): void {
  try {
    const text = readFileSync(".env", "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env: rely on the real environment */ }
}

async function main(): Promise<void> {
  loadDotEnv();
  const base = env("NAMECOM_BASE") || NAMECOM_SANDBOX_BASE;
  const username = env("NAMECOM_USER");
  const token = env("NAMECOM_TOKEN");

  if (base.replace(/\/$/, "") === NAMECOM_PRODUCTION_BASE) {
    console.error("REFUSING: NAMECOM_BASE points at production. This probe writes and deletes.");
    process.exit(2);
  }
  const isMock = !/(^|\.)name\.com$/.test(new URL(base).hostname);
  if (isMock && !process.env.DOORMAN_ALLOW_MOCK_PROBE) {
    console.error(
      `REFUSING: ${base} is not a name.com host. A receipt produced against a mock is not\n` +
      `evidence. Set DOORMAN_ALLOW_MOCK_PROBE=1 if you intend a mock-stamped dry run.`,
    );
    process.exit(2);
  }
  if (!username || !token) {
    console.error("REFUSING: NAMECOM_USER and NAMECOM_TOKEN must be set. Gate 0.2 is unmet.");
    process.exit(2);
  }
  if (!isMock && !username.endsWith("-test")) {
    console.error("REFUSING: sandbox requires the -test username suffix (CLAUDE.md §3).");
    process.exit(2);
  }

  const client = new NamecomClient({ base, username, token, maxRetries: 2 });
  const checks: Check[] = [];
  const unverified: string[] = [];

  // Unique per run so a re-run never collides with its own leftovers.
  const stamp = Date.now().toString(36);
  const domain = env("ANCHOR_DOMAIN") || `doorman-probe-${stamp}.com`;
  const box = `probe-${stamp}`;
  const to = env("PROBE_FORWARD_TO") || "doorman-probe@example.com";

  const run = async (id: string, op: string, fn: () => Promise<string>) => {
    try {
      const observed = await fn();
      checks.push({ id, op, status: "pass", httpStatus: lastStatus(), observed });
      console.log(`  pass  ${id}  ${observed}`);
    } catch (err: any) {
      const observed = `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`;
      checks.push({ id, op, status: "fail", httpStatus: err?.status ?? lastStatus(), observed });
      console.log(`  FAIL  ${id}  ${observed}`);
    }
  };
  const lastStatus = () => client.log.at(-1)?.status ?? null;

  console.log(`probing ${base} as ${username.replace(/./g, (c, i) => (i < 2 ? c : "*"))}`);

  await run("0.4.hello", `GET ${"/core/v1/hello"}`, async () => {
    const r = await client.hello();
    return `serverName=${r.serverName ?? "?"}`;
  });

  await run("0.4.domain.create", "POST /core/v1/domains", async () => {
    try {
      const d = await client.createDomain(domain);
      return `created ${d.domainName} expires ${d.expireDate ?? "?"}`;
    } catch (err: any) {
      if (err?.status === 409) {
        const d = await client.getDomain(domain);
        return `already existed ${d.domainName} expires ${d.expireDate ?? "?"}`;
      }
      throw err;
    }
  });

  await run("0.4.fwd.create", "POST /core/v1/domains/{d}/email/forwarding", async () => {
    const f = await client.createEmailForwarding(domain, box, to);
    return `created ${f.emailBox}@${domain}`;
  });

  // The read-back the writer does not control. Do not trust the 201.
  await run("0.4.fwd.readback", "GET /core/v1/domains/{d}/email/forwarding", async () => {
    const list = await client.listEmailForwardings(domain);
    const found = (list.emailForwarding ?? []).some((f) => f.emailBox === box);
    if (!found) throw new Error(`created forwarding ${box} absent from list`);
    return `present in list (${(list.emailForwarding ?? []).length} total)`;
  });

  await run("0.4.fwd.delete", "DELETE /core/v1/domains/{d}/email/forwarding/{box}", async () => {
    await client.deleteEmailForwarding(domain, box);
    return "delete accepted";
  });

  await run("0.4.fwd.readback2", "GET /core/v1/domains/{d}/email/forwarding (absence)", async () => {
    const list = await client.listEmailForwardings(domain);
    const found = (list.emailForwarding ?? []).some((f) => f.emailBox === box);
    if (found) throw new Error(`deleted forwarding ${box} still present in list`);
    return "absent from list after delete";
  });

  if (isMock) {
    unverified.push(
      "Every check above ran against a LOCAL MOCK, not name.com. This receipt proves the " +
      "probe harness runs; it proves nothing about the name.com API.",
    );
  }
  unverified.push(
    "Endpoint paths in src/namecom.ts PATHS are written from documentation. Only the paths " +
    "exercised above and marked pass have been observed to exist.",
  );
  if (checks.some((c) => c.status === "fail")) {
    unverified.push("At least one check FAILED. Gate 0.4 is not passed. See failures above.");
  }

  const receipt = {
    header: HEADER,
    ranAtUtc: new Date().toISOString(),
    base,
    target: isMock ? "LOCAL MOCK — NOT NAME.COM" : "name.com sandbox",
    gate: "0.4",
    checks,
    requestLog: client.log,
    unverified,
  };

  mkdirSync("ci", { recursive: true });
  const out = isMock ? "ci/probe.mock.json" : "ci/probe.json";
  writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`\nwrote ${out}`);

  process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
