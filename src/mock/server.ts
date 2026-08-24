/**
 * Local mock of the name.com CORE API v1.
 *
 * WHAT THIS IS FOR: this session's environment blocks egress to
 * api.dev.name.com (see ci/env-probe.json), so the mock lets the spine be
 * built and exercised before a token exists. It is SCAFFOLDING.
 *
 * WHAT IT IS NOT: evidence. It encodes our assumptions about the API, so a
 * mock passing proves only that our code agrees with our own guesses.
 * CLAUDE.md §5: a read passing does not license a write; a mock passing
 * licenses nothing at all. ci/probe.json must NEVER be produced from this —
 * scripts/probe.ts refuses to write a receipt against a non-name.com base
 * unless DOORMAN_ALLOW_MOCK_PROBE is set, and stamps the receipt as mock.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Forwarding { emailBox: string; emailTo: string }
interface UrlFwd { host: string; forwardsTo: string; type: string }
interface Rec { id: number; host: string; type: string; answer: string; ttl: number }
interface Hook { id: number; eventName: string; endpoint: string }

interface DomainState {
  domainName: string;
  expireDate: string;
  createDate: string;
  emailForwardings: Map<string, Forwarding>;
  urlForwardings: Map<string, UrlFwd>;
  records: Rec[];
}

const domains = new Map<string, DomainState>();
const webhooks: Hook[] = [];
let nextId = 1;

/** Reserved boxes the real registrar owns. Edge case 5 leans on this. */
const RESERVED = new Set(["admin", "postmaster", "abuse", "hostmaster", "webmaster"]);

/** Requests seen in the current second, so the mock can return a real 429. */
let secondBucket: number[] = [];
const PER_SECOND = Number(process.env.MOCK_RATE_LIMIT ?? 20);

function seedDomain(name: string, expireDate?: string): DomainState {
  const d: DomainState = {
    domainName: name,
    createDate: new Date().toISOString(),
    expireDate: expireDate ?? new Date(Date.now() + 365 * 864e5).toISOString(),
    emailForwardings: new Map(),
    urlForwardings: new Map(),
    records: [],
  };
  domains.set(name, d);
  return d;
}

// A domain that expires in 12 days, so edge case 4 (near-expiry refusal) has
// something real to refuse against.
seedDomain("midespensa.cl");
seedDomain("caducando.cl", new Date(Date.now() + 12 * 864e5).toISOString());

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

/** Mirrors the sandbox rule: Basic auth, username must end in -test. */
function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (!h?.startsWith("Basic ")) return false;
  const [user, token] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return Boolean(user?.endsWith("-test") && token);
}

export function createMockServer() {
  return createServer(async (req, res) => {
    const now = Date.now();
    secondBucket = secondBucket.filter((t) => now - t < 1000);
    if (secondBucket.length >= PER_SECOND) {
      res.setHeader("Retry-After", "1");
      return send(res, 429, { message: "Rate limit exceeded" });
    }
    secondBucket.push(now);

    // Deliberately NOT decoded: the literal colon in domains:checkAvailability
    // is the quirk we are modelling.
    const path = (req.url ?? "").split("?")[0] ?? "";
    const method = req.method ?? "GET";

    if (!authOk(req)) {
      return send(res, 401, { message: "Authentication failed" });
    }

    if (method === "GET" && path === "/core/v1/hello") {
      return send(res, 200, { serverName: "mock", motd: "local mock, not name.com", username: "demo-test" });
    }
    if (method === "GET" && path === "/core/v1/accountinfo") {
      return send(res, 200, { username: "demo-test", balance: "0.00" });
    }
    if (method === "POST" && path === "/core/v1/domains:checkAvailability") {
      const body = await readBody(req);
      const names: string[] = body.domainNames ?? [];
      return send(res, 200, {
        results: names.map((n) => ({ domainName: n, purchasable: !domains.has(n), premium: false })),
      });
    }
    if (method === "GET" && path === "/core/v1/domains") {
      return send(res, 200, { domains: [...domains.values()].map(publicDomain) });
    }
    if (method === "POST" && path === "/core/v1/domains") {
      const body = await readBody(req);
      const name = body?.domain?.domainName;
      if (!name) return send(res, 400, { message: "domain.domainName is required" });
      if (domains.has(name)) return send(res, 409, { message: "Domain already exists" });
      return send(res, 201, publicDomain(seedDomain(name)));
    }

    const m = path.match(/^\/core\/v1\/domains\/([^/]+)(\/.*)?$/);
    if (m) {
      const domain = domains.get(decodeURIComponent(m[1]!));
      const rest = m[2] ?? "";
      if (!domain) return send(res, 404, { message: "Domain not found" });

      if (method === "GET" && rest === "") return send(res, 200, publicDomain(domain));

      // ---- email forwardings: the identity itself
      if (rest === "/email/forwarding") {
        if (method === "GET") {
          return send(res, 200, { emailForwarding: [...domain.emailForwardings.values()] });
        }
        if (method === "POST") {
          const body = await readBody(req);
          const box = String(body.emailBox ?? "").toLowerCase();
          const to = String(body.emailTo ?? "");
          if (!box || !to) return send(res, 400, { message: "emailBox and emailTo are required" });
          if (RESERVED.has(box)) return send(res, 403, { message: `${box} is reserved` });
          if (domain.emailForwardings.has(box)) return send(res, 409, { message: "Forwarding exists" });
          const fwd = { emailBox: box, emailTo: to };
          domain.emailForwardings.set(box, fwd);
          return send(res, 201, { domainName: domain.domainName, ...fwd });
        }
      }
      const boxMatch = rest.match(/^\/email\/forwarding\/([^/]+)$/);
      if (boxMatch) {
        const box = decodeURIComponent(boxMatch[1]!).toLowerCase();
        const existing = domain.emailForwardings.get(box);
        if (method === "GET") {
          return existing
            ? send(res, 200, { domainName: domain.domainName, ...existing })
            : send(res, 404, { message: "Forwarding not found" });
        }
        if (method === "PUT") {
          if (!existing) return send(res, 404, { message: "Forwarding not found" });
          const body = await readBody(req);
          existing.emailTo = String(body.emailTo ?? existing.emailTo);
          return send(res, 200, { domainName: domain.domainName, ...existing });
        }
        if (method === "DELETE") {
          if (!existing) return send(res, 404, { message: "Forwarding not found" });
          domain.emailForwardings.delete(box);
          return send(res, 200, {});
        }
      }

      // ---- url forwardings
      if (rest === "/url/forwarding") {
        if (method === "GET") return send(res, 200, { urlForwarding: [...domain.urlForwardings.values()] });
        if (method === "POST") {
          const body = await readBody(req);
          const host = String(body.host ?? "");
          if (!host) return send(res, 400, { message: "host is required" });
          const u = { host, forwardsTo: String(body.forwardsTo ?? ""), type: String(body.type ?? "redirect") };
          domain.urlForwardings.set(host, u);
          return send(res, 201, { domainName: domain.domainName, ...u });
        }
      }
      const hostMatch = rest.match(/^\/url\/forwarding\/([^/]+)$/);
      if (hostMatch && method === "DELETE") {
        const host = decodeURIComponent(hostMatch[1]!);
        if (!domain.urlForwardings.delete(host)) return send(res, 404, { message: "Not found" });
        return send(res, 200, {});
      }

      // ---- dns records
      if (rest === "/records") {
        if (method === "GET") return send(res, 200, { records: domain.records });
        if (method === "POST") {
          const body = await readBody(req);
          const rec: Rec = {
            id: nextId++,
            host: String(body.host ?? ""),
            type: String(body.type ?? "TXT"),
            answer: String(body.answer ?? ""),
            ttl: Number(body.ttl ?? 300),
          };
          domain.records.push(rec);
          return send(res, 201, { domainName: domain.domainName, fqdn: `${rec.host}.${domain.domainName}.`, ...rec });
        }
      }
      const recMatch = rest.match(/^\/records\/(\d+)$/);
      if (recMatch && method === "DELETE") {
        const id = Number(recMatch[1]);
        const i = domain.records.findIndex((r) => r.id === id);
        if (i < 0) return send(res, 404, { message: "Record not found" });
        domain.records.splice(i, 1);
        return send(res, 200, {});
      }
    }

    // ---- webhook notifications
    if (path === "/core/v1/webhook_notifications") {
      if (method === "GET") return send(res, 200, { webhookNotifications: webhooks });
      if (method === "POST") {
        const body = await readBody(req);
        const hook: Hook = {
          id: nextId++,
          eventName: String(body.eventName ?? ""),
          endpoint: String(body.endpoint ?? ""),
        };
        webhooks.push(hook);
        return send(res, 201, hook);
      }
    }

    return send(res, 404, { message: `No mock route for ${method} ${path}` });
  });
}

function publicDomain(d: DomainState) {
  return {
    domainName: d.domainName,
    createDate: d.createDate,
    expireDate: d.expireDate,
    autorenewEnabled: true,
    locked: false,
  };
}

const isMain = process.argv[1]?.endsWith("mock/server.ts");
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  createMockServer().listen(port, "127.0.0.1", () => {
    console.log(`mock name.com listening on http://127.0.0.1:${port}`);
    console.log(`seeded domains: ${[...domains.keys()].join(", ")}`);
  });
}
