/**
 * Thin typed client for the name.com CORE API v1.
 *
 * VERIFICATION STATUS — read this before trusting anything below.
 *
 * The PATHS table is the ONLY place endpoint paths appear. It was written from
 * documentation, NOT from a live call, and is therefore UNVERIFIED. Gate 0.4 in
 * BUILD-SPEC.md exists to verify it against the sandbox with a real token. When
 * a path turns out to be wrong, fix it HERE and nowhere else.
 *
 * Two facts that bite, both from CLAUDE.md §3:
 *   - Do NOT URL-encode the colon in `domains:checkAvailability`.
 *   - Sandbox auth appends `-test` to the username and uses the sandbox token.
 */

export const NAMECOM_SANDBOX_BASE = "https://api.dev.name.com";
export const NAMECOM_PRODUCTION_BASE = "https://api.name.com";

/** Documented limits (CLAUDE.md §3). Enforced client-side by RateLimiter. */
export const RATE_LIMIT_PER_SECOND = 20;
export const RATE_LIMIT_PER_HOUR = 3000;

/**
 * UNVERIFIED until ci/probe.json says otherwise. See header.
 * `{d}` = domain name, `{box}` = email local-part, `{host}` = subdomain host.
 */
export const PATHS = {
  hello: () => `/core/v1/hello`,
  accountInfo: () => `/core/v1/accountinfo`,

  domainsList: () => `/core/v1/domains`,
  domainGet: (d: string) => `/core/v1/domains/${encodeURIComponent(d)}`,
  domainCreate: () => `/core/v1/domains`,
  // NOTE: the colon is literal and must NOT be percent-encoded.
  domainsCheckAvailability: () => `/core/v1/domains:checkAvailability`,
  domainsSearch: () => `/core/v1/domains:search`,

  emailForwardingsList: (d: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/email/forwarding`,
  emailForwardingCreate: (d: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/email/forwarding`,
  emailForwardingGet: (d: string, box: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/email/forwarding/${encodeURIComponent(box)}`,
  emailForwardingDelete: (d: string, box: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/email/forwarding/${encodeURIComponent(box)}`,

  urlForwardingsList: (d: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/url/forwarding`,
  urlForwardingCreate: (d: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/url/forwarding`,
  urlForwardingDelete: (d: string, host: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/url/forwarding/${encodeURIComponent(host)}`,

  dnsRecordsList: (d: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/records`,
  dnsRecordCreate: (d: string) =>
    `/core/v1/domains/${encodeURIComponent(d)}/records`,
  dnsRecordDelete: (d: string, id: number) =>
    `/core/v1/domains/${encodeURIComponent(d)}/records/${id}`,

  webhookNotificationsList: () => `/core/v1/webhook_notifications`,
  webhookNotificationCreate: () => `/core/v1/webhook_notifications`,
  webhookNotificationDelete: (id: number) => `/core/v1/webhook_notifications/${id}`,
} as const;

// ---------------------------------------------------------------- error types

export class NamecomError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`name.com ${method} ${path} -> ${status}`);
    this.name = "NamecomError";
  }
}

/** 429. Carries retry hint when the response supplies one. */
export class NamecomRateLimitError extends NamecomError {
  constructor(
    method: string,
    path: string,
    body: unknown,
    readonly retryAfterMs: number,
  ) {
    super(429, method, path, body);
    this.name = "NamecomRateLimitError";
  }
}

/** 401/403 — the credential is wrong, not the request. Never retry these. */
export class NamecomAuthError extends NamecomError {
  constructor(status: number, method: string, path: string, body: unknown) {
    super(status, method, path, body);
    this.name = "NamecomAuthError";
  }
}

/** 404 — used by read-backs to prove absence after a delete. */
export class NamecomNotFoundError extends NamecomError {
  constructor(method: string, path: string, body: unknown) {
    super(404, method, path, body);
    this.name = "NamecomNotFoundError";
  }
}

// ------------------------------------------------------------- rate limiting

/**
 * Client-side throttle. Edge case 6 in BUILD-SPEC.md requires a batch of 30 to
 * complete without tripping the documented ceiling, so we shape traffic before
 * the API has to reject it.
 */
export class RateLimiter {
  private secondWindow: number[] = [];
  private hourWindow: number[] = [];

  constructor(
    private readonly perSecond = RATE_LIMIT_PER_SECOND,
    private readonly perHour = RATE_LIMIT_PER_HOUR,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Milliseconds the caller must wait before the next request is in-budget. */
  delayMs(): number {
    const t = this.now();
    this.secondWindow = this.secondWindow.filter((x) => t - x < 1000);
    this.hourWindow = this.hourWindow.filter((x) => t - x < 3_600_000);
    if (this.hourWindow.length >= this.perHour) {
      return 3_600_000 - (t - this.hourWindow[0]!);
    }
    if (this.secondWindow.length >= this.perSecond) {
      return 1000 - (t - this.secondWindow[0]!);
    }
    return 0;
  }

  record(): void {
    const t = this.now();
    this.secondWindow.push(t);
    this.hourWindow.push(t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- client

export interface NamecomConfig {
  base: string;
  username: string;
  token: string;
  /** Retries apply to 429 and 5xx only. Never to 4xx. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestRecord {
  method: string;
  path: string;
  status: number;
  ms: number;
}

export class NamecomClient {
  private readonly limiter = new RateLimiter();
  /** Every call made, in order. The events table and receipts read this. */
  readonly log: RequestRecord[] = [];

  constructor(private readonly cfg: NamecomConfig) {
    if (!cfg.base) throw new Error("NAMECOM_BASE is required");
    if (!cfg.username) throw new Error("NAMECOM_USER is required");
    if (!cfg.token) throw new Error("NAMECOM_TOKEN is required");
  }

  /** True when pointed at production, where writes cost real money. */
  get isProduction(): boolean {
    return this.cfg.base.replace(/\/$/, "") === NAMECOM_PRODUCTION_BASE;
  }

  private authHeader(): string {
    const raw = `${this.cfg.username}:${this.cfg.token}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const maxRetries = this.cfg.maxRetries ?? 3;
    // The colon in `domains:checkAvailability` must survive intact, so the path
    // is concatenated raw rather than passed through a URL builder.
    const url = `${this.cfg.base.replace(/\/$/, "")}${path}`;

    for (let attempt = 0; ; attempt++) {
      const wait = this.limiter.delayMs();
      if (wait > 0) await sleep(wait);
      this.limiter.record();

      const started = Date.now();
      const res = await doFetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const ms = Date.now() - started;
      this.log.push({ method, path, status: res.status, ms });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (res.ok) return parsed as T;

      if (res.status === 429) {
        const header = res.headers.get("retry-after");
        const retryAfterMs = header ? Number(header) * 1000 : 1000 * 2 ** attempt;
        if (attempt < maxRetries) {
          await sleep(retryAfterMs);
          continue;
        }
        throw new NamecomRateLimitError(method, path, parsed, retryAfterMs);
      }
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new NamecomAuthError(res.status, method, path, parsed);
      }
      if (res.status === 404) {
        throw new NamecomNotFoundError(method, path, parsed);
      }
      throw new NamecomError(res.status, method, path, parsed);
    }
  }

  // --------------------------------------------------------- typed surfaces

  hello() {
    return this.request<HelloResponse>("GET", PATHS.hello());
  }

  accountInfo() {
    return this.request<AccountInfo>("GET", PATHS.accountInfo());
  }

  getDomain(domain: string) {
    return this.request<DomainRecord>("GET", PATHS.domainGet(domain));
  }

  checkAvailability(domainNames: string[]) {
    return this.request<{ results: AvailabilityResult[] }>(
      "POST",
      PATHS.domainsCheckAvailability(),
      { domainNames },
    );
  }

  /**
   * Sandbox-only by policy. CLAUDE.md §3: no production registration, ever.
   * The guard is here rather than at the call site so no future caller can
   * forget it.
   */
  createDomain(domainName: string, years = 1) {
    if (this.isProduction) {
      throw new Error(
        "Refusing to register a domain against the production base URL. " +
          "Doorman is sandbox-only; production registration spends real money.",
      );
    }
    return this.request<DomainRecord>("POST", PATHS.domainCreate(), {
      domain: { domainName },
      years,
    });
  }

  listEmailForwardings(domain: string) {
    return this.request<{ emailForwarding: EmailForwarding[] }>(
      "GET",
      PATHS.emailForwardingsList(domain),
    );
  }

  createEmailForwarding(domain: string, emailBox: string, emailTo: string) {
    return this.request<EmailForwarding>(
      "POST",
      PATHS.emailForwardingCreate(domain),
      { emailBox, emailTo },
    );
  }

  deleteEmailForwarding(domain: string, emailBox: string) {
    return this.request<unknown>(
      "DELETE",
      PATHS.emailForwardingDelete(domain, emailBox),
    );
  }

  listUrlForwardings(domain: string) {
    return this.request<{ urlForwarding: UrlForwarding[] }>(
      "GET",
      PATHS.urlForwardingsList(domain),
    );
  }

  createUrlForwarding(domain: string, host: string, forwardsTo: string) {
    return this.request<UrlForwarding>("POST", PATHS.urlForwardingCreate(domain), {
      host,
      forwardsTo,
      type: "redirect",
    });
  }

  listDnsRecords(domain: string) {
    return this.request<{ records: DnsRecord[] }>("GET", PATHS.dnsRecordsList(domain));
  }

  createDnsRecord(domain: string, rec: NewDnsRecord) {
    return this.request<DnsRecord>("POST", PATHS.dnsRecordCreate(domain), rec);
  }

  listWebhookNotifications() {
    return this.request<{ webhookNotifications: WebhookNotification[] }>(
      "GET",
      PATHS.webhookNotificationsList(),
    );
  }

  createWebhookNotification(eventName: string, endpoint: string) {
    return this.request<WebhookNotification>(
      "POST",
      PATHS.webhookNotificationCreate(),
      { eventName, endpoint },
    );
  }
}

// -------------------------------------------------------------------- shapes
// Response shapes are best-effort from documentation and are UNVERIFIED.
// Anything the code actually branches on must be confirmed by Gate 0.4.

export interface HelloResponse {
  serverName?: string;
  motd?: string;
  username?: string;
}

export interface AccountInfo {
  username?: string;
  balance?: number | string;
  contact?: Record<string, unknown>;
}

export interface DomainRecord {
  domainName: string;
  expireDate?: string;
  createDate?: string;
  autorenewEnabled?: boolean;
  locked?: boolean;
}

export interface AvailabilityResult {
  domainName: string;
  purchasable?: boolean;
  premium?: boolean;
  purchasePrice?: number;
}

export interface EmailForwarding {
  domainName?: string;
  emailBox: string;
  emailTo: string;
}

export interface UrlForwarding {
  domainName?: string;
  host: string;
  forwardsTo: string;
  type?: string;
}

export interface NewDnsRecord {
  host: string;
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX";
  answer: string;
  ttl?: number;
}

export interface DnsRecord extends NewDnsRecord {
  id: number;
  domainName?: string;
  fqdn?: string;
}

export interface WebhookNotification {
  id: number;
  eventName: string;
  endpoint: string;
}
