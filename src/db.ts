/**
 * SQLite persistence: suppliers · identities · events.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE:
 * every mutation writes an `events` row recording what changed, when, which
 * name.com call was involved and what came back. That is why there are no
 * exported `INSERT`/`UPDATE` helpers that take a bare row — each mutation is a
 * function that opens a transaction, writes the domain row AND its event, and
 * commits both or neither. A caller cannot mutate without leaving a trace,
 * because there is no code path that lets it.
 *
 * The events table is the audit surface for §5 "before asserting state, read it
 * from whatever owns it": name.com owns identity state, this table owns the
 * record of what we asked it to do and what it answered.
 */
import Database from "better-sqlite3";

export type IdentityStatus = "live" | "revoked" | "failed";

export interface Supplier {
  id: number;
  legalName: string;
  tradeName: string;
  /** RUT in Chile. The thing that actually distinguishes two "Panadería San José". */
  taxId: string;
  /** The inbox the supplier already reads. Gmail, phone-linked, whatever. */
  destination: string;
  createdAt: string;
}

export interface Identity {
  id: number;
  supplierId: number;
  domain: string;
  /** Local part only: `lacteos-riquelme`, not the full address. */
  alias: string;
  destination: string;
  status: IdentityStatus;
  mintedAt: string;
  revokedAt: string | null;
}

/**
 * One row per mutation. `apiStatus` is the HTTP status name.com actually
 * returned, not what we expected it to return.
 */
export interface EventRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  subjectType: "supplier" | "identity";
  subjectId: number | null;
  apiMethod: string | null;
  apiPath: string | null;
  apiStatus: number | null;
  detail: string | null;
}

export interface ApiTrace {
  method: string;
  path: string;
  status: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  legal_name   TEXT NOT NULL,
  trade_name   TEXT NOT NULL,
  tax_id       TEXT NOT NULL UNIQUE,
  destination  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
  domain       TEXT NOT NULL,
  alias        TEXT NOT NULL,
  destination  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('live','revoked','failed')),
  minted_at    TEXT NOT NULL,
  revoked_at   TEXT
);

-- One live alias per domain. Edge case 1 must resolve a collision by suffixing,
-- never by silently overwriting, and the database refuses to let it.
CREATE UNIQUE INDEX IF NOT EXISTS identities_live_alias
  ON identities (domain, alias) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   INTEGER,
  api_method   TEXT,
  api_path     TEXT,
  api_status   INTEGER,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS events_subject ON events (subject_type, subject_id, id);
`;

export interface EventInput {
  actor: string;
  action: string;
  subjectType: "supplier" | "identity";
  subjectId: number | null;
  api?: ApiTrace | null;
  detail?: unknown;
}

export class DoormanDb {
  private readonly db: Database.Database;

  constructor(file = process.env.DOORMAN_DB ?? "doorman.db") {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * Private on purpose. Events are written by the mutation that caused them,
   * inside the same transaction, so an event can never describe a change that
   * did not commit — nor a change commit without its event.
   */
  private insertEvent(e: EventInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (at, actor, action, subject_type, subject_id,
                             api_method, api_path, api_status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        e.actor,
        e.action,
        e.subjectType,
        e.subjectId,
        e.api?.method ?? null,
        e.api?.path ?? null,
        e.api?.status ?? null,
        e.detail === undefined ? null : JSON.stringify(e.detail),
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Records something that happened without a row change — a refusal, or a
   * failed API call. A refusal is a product behaviour (CLAUDE.md §6), so it is
   * part of the audit trail, not an error swallowed at the boundary.
   */
  recordEvent(e: EventInput): number {
    return this.db.transaction(() => this.insertEvent(e))();
  }

  // ------------------------------------------------------------- suppliers

  createSupplier(
    input: Omit<Supplier, "id" | "createdAt">,
    actor: string,
  ): Supplier {
    return this.db.transaction(() => {
      const at = this.now();
      const info = this.db
        .prepare(
          `INSERT INTO suppliers (legal_name, trade_name, tax_id, destination, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.legalName, input.tradeName, input.taxId, input.destination, at);
      const id = Number(info.lastInsertRowid);
      this.insertEvent({
        actor,
        action: "supplier.create",
        subjectType: "supplier",
        subjectId: id,
        detail: { tradeName: input.tradeName, taxId: input.taxId },
      });
      return { id, createdAt: at, ...input };
    })();
  }

  getSupplier(id: number): Supplier | undefined {
    const r = this.db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id) as any;
    return r ? rowToSupplier(r) : undefined;
  }

  getSupplierByTaxId(taxId: string): Supplier | undefined {
    const r = this.db.prepare(`SELECT * FROM suppliers WHERE tax_id = ?`).get(taxId) as any;
    return r ? rowToSupplier(r) : undefined;
  }

  /** Backs refusal 3: same trade name, different tax ID must not auto-merge. */
  findSuppliersByTradeName(tradeName: string): Supplier[] {
    const rows = this.db
      .prepare(`SELECT * FROM suppliers WHERE lower(trade_name) = lower(?) ORDER BY id`)
      .all(tradeName) as any[];
    return rows.map(rowToSupplier);
  }

  listSuppliers(): Supplier[] {
    const rows = this.db.prepare(`SELECT * FROM suppliers ORDER BY id`).all() as any[];
    return rows.map(rowToSupplier);
  }

  // ------------------------------------------------------------ identities

  /**
   * Called only after the API write AND its read-back have both succeeded, so
   * a `live` row in this table always corresponds to a forwarding observed to
   * exist at name.com — not to a 201 we chose to believe.
   */
  recordMintedIdentity(
    input: {
      supplierId: number;
      domain: string;
      alias: string;
      destination: string;
    },
    actor: string,
    api: ApiTrace,
    detail?: unknown,
  ): Identity {
    return this.db.transaction(() => {
      const at = this.now();
      const info = this.db
        .prepare(
          `INSERT INTO identities (supplier_id, domain, alias, destination, status, minted_at)
           VALUES (?, ?, ?, ?, 'live', ?)`,
        )
        .run(input.supplierId, input.domain, input.alias, input.destination, at);
      const id = Number(info.lastInsertRowid);
      this.insertEvent({
        actor,
        action: "identity.mint",
        subjectType: "identity",
        subjectId: id,
        api,
        detail: detail ?? { alias: `${input.alias}@${input.domain}`, to: input.destination },
      });
      return {
        id,
        supplierId: input.supplierId,
        domain: input.domain,
        alias: input.alias,
        destination: input.destination,
        status: "live" as const,
        mintedAt: at,
        revokedAt: null,
      };
    })();
  }

  /** Called only after the delete AND the absence read-back have succeeded. */
  recordRevokedIdentity(id: number, actor: string, api: ApiTrace, detail?: unknown): void {
    this.db.transaction(() => {
      const at = this.now();
      const info = this.db
        .prepare(`UPDATE identities SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'live'`)
        .run(at, id);
      if (info.changes === 0) {
        throw new Error(`identity ${id} is not live; refusing to record a revoke that changed nothing`);
      }
      this.insertEvent({
        actor,
        action: "identity.revoke",
        subjectType: "identity",
        subjectId: id,
        api,
        detail: detail ?? null,
      });
    })();
  }

  /**
   * Edge case 2: the alias never changes, only where it points. Nothing already
   * printed on a delivery slip becomes wrong.
   */
  recordDestinationChange(
    id: number,
    destination: string,
    actor: string,
    api: ApiTrace,
  ): void {
    this.db.transaction(() => {
      const before = this.db.prepare(`SELECT destination FROM identities WHERE id = ?`).get(id) as any;
      if (!before) throw new Error(`identity ${id} not found`);
      this.db.prepare(`UPDATE identities SET destination = ? WHERE id = ?`).run(destination, id);
      this.insertEvent({
        actor,
        action: "identity.destination.update",
        subjectType: "identity",
        subjectId: id,
        api,
        detail: { from: before.destination, to: destination, aliasUnchanged: true },
      });
    })();
  }

  getIdentity(id: number): Identity | undefined {
    const r = this.db.prepare(`SELECT * FROM identities WHERE id = ?`).get(id) as any;
    return r ? rowToIdentity(r) : undefined;
  }

  listIdentities(supplierId?: number): Identity[] {
    const rows = (
      supplierId === undefined
        ? this.db.prepare(`SELECT * FROM identities ORDER BY id`).all()
        : this.db.prepare(`SELECT * FROM identities WHERE supplier_id = ? ORDER BY id`).all(supplierId)
    ) as any[];
    return rows.map(rowToIdentity);
  }

  /** Live aliases on a domain, for collision detection before minting. */
  liveAliases(domain: string): string[] {
    const rows = this.db
      .prepare(`SELECT alias FROM identities WHERE domain = ? AND status = 'live'`)
      .all(domain) as any[];
    return rows.map((r) => String(r.alias));
  }

  // ---------------------------------------------------------------- events

  listEvents(limit = 100): EventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map(rowToEvent);
  }

  eventsFor(subjectType: "supplier" | "identity", subjectId: number): EventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE subject_type = ? AND subject_id = ? ORDER BY id`)
      .all(subjectType, subjectId) as any[];
    return rows.map(rowToEvent);
  }

  countEvents(): number {
    const r = this.db.prepare(`SELECT count(*) AS n FROM events`).get() as any;
    return Number(r.n);
  }
}

function rowToSupplier(r: any): Supplier {
  return {
    id: Number(r.id),
    legalName: String(r.legal_name),
    tradeName: String(r.trade_name),
    taxId: String(r.tax_id),
    destination: String(r.destination),
    createdAt: String(r.created_at),
  };
}

function rowToIdentity(r: any): Identity {
  return {
    id: Number(r.id),
    supplierId: Number(r.supplier_id),
    domain: String(r.domain),
    alias: String(r.alias),
    destination: String(r.destination),
    status: String(r.status) as IdentityStatus,
    mintedAt: String(r.minted_at),
    revokedAt: r.revoked_at === null ? null : String(r.revoked_at),
  };
}

function rowToEvent(r: any): EventRow {
  return {
    id: Number(r.id),
    at: String(r.at),
    actor: String(r.actor),
    action: String(r.action),
    subjectType: r.subject_type,
    subjectId: r.subject_id === null ? null : Number(r.subject_id),
    apiMethod: r.api_method === null ? null : String(r.api_method),
    apiPath: r.api_path === null ? null : String(r.api_path),
    apiStatus: r.api_status === null ? null : Number(r.api_status),
    detail: r.detail === null ? null : String(r.detail),
  };
}
