/**
 * mint() / revoke() — the spine.
 *
 * TWO RULES SHAPE EVERY FUNCTION HERE.
 *
 * 1. Every write is followed by a read-back the writer does not control
 *    (CLAUDE.md §5). We create a forwarding, then LIST forwardings from the API
 *    and look for it. We delete a forwarding, then LIST again and confirm it is
 *    gone. A 201 is a claim; the list is the observation. Nothing is written to
 *    the database until the observation agrees.
 *
 * 2. Doorman declines rather than guesses (CLAUDE.md §6). The three refusals
 *    below each throw a `Refusal` carrying ONE plain sentence meant to be
 *    rendered on screen — not a 400 in a log. A refusal is a product behaviour,
 *    so it is recorded in `events` like any other outcome.
 */
import type { NamecomClient } from "./namecom.ts";
import { PATHS } from "./namecom.ts";
import type { ApiTrace, DoormanDb, Identity, Supplier } from "./db.ts";

export type RefusalCode =
  | "reserved-alias"
  | "anchor-expires-first"
  | "trade-name-tax-id-conflict";

/**
 * A deliberate decline. `sentence` is display copy: one plain sentence, no
 * jargon, no error code. It goes on the screen verbatim.
 */
export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly sentence: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(sentence);
    this.name = "Refusal";
  }
}

/**
 * Raised when the API accepted a write but the independent read-back did not
 * confirm it. Distinct from a Refusal: this is a disagreement with name.com,
 * not a decision by us.
 */
export class ReadBackFailure extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReadBackFailure";
  }
}

/**
 * Boxes the domain itself owns. The first three are named in CLAUDE.md §6; the
 * rest are RFC 2142 mailbox names a registrar or CA may rely on. We refuse
 * these outright rather than silently renaming them, because a supplier whose
 * address was quietly changed will keep using the one they were told.
 */
export const RESERVED_ALIASES = new Set([
  "admin", "postmaster", "abuse", "hostmaster", "webmaster",
  "root", "security", "noc", "ssl-admin", "mailer-daemon",
]);

/**
 * Default stated lifetime of an issued identity when the caller names none.
 *
 * ASSUMPTION (stated, not derived from the spec): 90 days — one quarter, the
 * natural review cycle for a supplier relationship.
 *
 * It is deliberately SHORTER than a domain registration term. Exercising this
 * against the mock surfaced the reason: a default of 365 days makes refusal 2
 * fire on every freshly registered anchor domain, because a domain bought for
 * one year always expires slightly before a 365-day identity would end. The
 * refusal was correct and the default was wrong. An identity must fit inside
 * the remaining life of the domain that carries it, with room to spare.
 */
export const DEFAULT_IDENTITY_LIFETIME_DAYS = 90;

export interface IdentityDeps {
  db: DoormanDb;
  client: NamecomClient;
  domain: string;
  actor: string;
}

// --------------------------------------------------------------- alias rules

/** `Lácteos Riquelme Ltda.` -> `lacteos-riquelme-ltda`. */
export function deriveAlias(tradeName: string): string {
  const slug = tradeName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) throw new Error(`trade name ${JSON.stringify(tradeName)} yields no usable alias`);
  return slug;
}

/** Edge case 1: two suppliers share a trade name. Suffix, never overwrite. */
export function taxIdSuffix(taxId: string): string {
  const digits = taxId.replace(/[^0-9kK]/g, "");
  return digits.slice(0, 8) || "x";
}

// ------------------------------------------------------------- the refusals

/** REFUSAL 1 — reserved-address collision. Refuse, do not mangle. */
export function assertAliasNotReserved(alias: string): void {
  if (RESERVED_ALIASES.has(alias.toLowerCase())) {
    throw new Refusal(
      "reserved-alias",
      `\`${alias}@\` is reserved for the domain itself. Pick another alias — we won't rename it for you.`,
      { alias },
    );
  }
}

/**
 * REFUSAL 2 — the anchor domain expires inside the identity's stated lifetime.
 * The identity would outlive its own foundation.
 *
 * `expireDate` must come from the API (`GET /core/v1/domains/{d}`), never from
 * our own database: name.com owns that fact.
 */
export function assertAnchorOutlivesIdentity(
  domain: string,
  expireDateIso: string | undefined,
  lifetimeDays: number,
  now: Date = new Date(),
): void {
  if (!expireDateIso) {
    throw new Refusal(
      "anchor-expires-first",
      `We can't read when ${domain} expires, so we won't issue an identity that might outlive it.`,
      { domain, expireDate: null, lifetimeDays },
    );
  }
  const expires = new Date(expireDateIso);
  if (Number.isNaN(expires.getTime())) {
    throw new Refusal(
      "anchor-expires-first",
      `We can't read when ${domain} expires, so we won't issue an identity that might outlive it.`,
      { domain, expireDate: expireDateIso, lifetimeDays },
    );
  }
  const identityEnds = new Date(now.getTime() + lifetimeDays * 864e5);
  if (expires < identityEnds) {
    const days = Math.max(0, Math.round((expires.getTime() - now.getTime()) / 864e5));
    throw new Refusal(
      "anchor-expires-first",
      `We won't issue this identity: the domain it lives on expires before the identity is meant to.`,
      { domain, expireDate: expires.toISOString(), daysToExpiry: days, lifetimeDays },
    );
  }
}

/**
 * REFUSAL 3 — same trade name, different tax ID. Propose, require confirmation.
 * Returns the existing supplier when the tax IDs match (a genuine re-onboard).
 */
export function assertNoAmbiguousMerge(
  db: DoormanDb,
  candidate: { tradeName: string; taxId: string },
  confirmedDistinct = false,
): Supplier | undefined {
  const sameTrade = db.findSuppliersByTradeName(candidate.tradeName);
  const sameTaxId = sameTrade.find((s) => s.taxId === candidate.taxId);
  if (sameTaxId) return sameTaxId;
  const conflicting = sameTrade.filter((s) => s.taxId !== candidate.taxId);
  if (conflicting.length > 0 && !confirmedDistinct) {
    throw new Refusal(
      "trade-name-tax-id-conflict",
      `Two suppliers, same trade name, different tax ID. We won't merge them. Confirm which one this is.`,
      {
        tradeName: candidate.tradeName,
        incomingTaxId: candidate.taxId,
        existingTaxIds: conflicting.map((s) => s.taxId),
        existingSupplierIds: conflicting.map((s) => s.id),
      },
    );
  }
  return undefined;
}

// ------------------------------------------------------------------ helpers

function trace(client: NamecomClient): ApiTrace {
  const last = client.log.at(-1);
  return {
    method: last?.method ?? "?",
    path: last?.path ?? "?",
    status: last?.status ?? 0,
  };
}

function recordRefusal(
  deps: IdentityDeps,
  refusal: Refusal,
  subjectType: "supplier" | "identity",
  subjectId: number | null,
): void {
  deps.db.recordEvent({
    actor: deps.actor,
    action: `refusal.${refusal.code}`,
    subjectType,
    subjectId,
    api: null,
    detail: { sentence: refusal.sentence, ...refusal.detail },
  });
}

// --------------------------------------------------------------- onboarding

export interface OnboardInput {
  legalName: string;
  tradeName: string;
  taxId: string;
  destination: string;
  /** The buyer has looked at the conflict and says this is a different company. */
  confirmedDistinct?: boolean;
}

/**
 * Creates a supplier, or refuses when the trade name collides with a different
 * tax ID (refusal 3). Idempotent on tax ID: re-onboarding the same company
 * returns the existing row rather than duplicating it.
 */
export function onboardSupplier(deps: IdentityDeps, input: OnboardInput): Supplier {
  try {
    const existing = assertNoAmbiguousMerge(
      deps.db,
      { tradeName: input.tradeName, taxId: input.taxId },
      input.confirmedDistinct ?? false,
    );
    if (existing) return existing;
  } catch (err) {
    if (err instanceof Refusal) recordRefusal(deps, err, "supplier", null);
    throw err;
  }
  const byTaxId = deps.db.getSupplierByTaxId(input.taxId);
  if (byTaxId) return byTaxId;
  return deps.db.createSupplier(
    {
      legalName: input.legalName,
      tradeName: input.tradeName,
      taxId: input.taxId,
      destination: input.destination,
    },
    deps.actor,
  );
}

// -------------------------------------------------------------------- mint

export interface MintOptions {
  /** How long the issued identity is meant to last. Drives refusal 2. */
  lifetimeDays?: number;
  /** Override the derived alias (still subject to every refusal). */
  alias?: string;
}

export interface MintResult {
  identity: Identity;
  address: string;
  /** True when edge case 1 forced a tax-ID suffix onto the derived alias. */
  aliasWasSuffixed: boolean;
  readBack: { present: true; destinationMatches: boolean };
}

/**
 * Mints an identity for a supplier on the buyer's anchor domain.
 *
 * Order matters: refusals first (cheap, local, no API write), then the anchor
 * expiry check (an API READ), then the write, then the independent read-back.
 * We never write to name.com before we know we would accept the result.
 */
export async function mint(
  deps: IdentityDeps,
  supplierId: number,
  opts: MintOptions = {},
): Promise<MintResult> {
  const { db, client, domain } = deps;
  const supplier = db.getSupplier(supplierId);
  if (!supplier) throw new Error(`supplier ${supplierId} not found`);
  const lifetimeDays = opts.lifetimeDays ?? DEFAULT_IDENTITY_LIFETIME_DAYS;

  let alias = opts.alias ? deriveAlias(opts.alias) : deriveAlias(supplier.tradeName);

  try {
    assertAliasNotReserved(alias);

    // Read the expiry from the system that owns it, not from our database.
    const anchor = await client.getDomain(domain);
    assertAnchorOutlivesIdentity(domain, anchor.expireDate, lifetimeDays);
  } catch (err) {
    if (err instanceof Refusal) recordRefusal(deps, err, "supplier", supplierId);
    throw err;
  }

  // Edge case 1: a live alias already owns this name. Suffix with the tax ID
  // rather than overwriting somebody else's identity.
  let aliasWasSuffixed = false;
  const live = new Set(db.liveAliases(domain).map((a) => a.toLowerCase()));
  if (live.has(alias)) {
    const suffixed = `${alias}-${taxIdSuffix(supplier.taxId)}`;
    assertAliasNotReserved(suffixed);
    alias = suffixed;
    aliasWasSuffixed = true;
    db.recordEvent({
      actor: deps.actor,
      action: "identity.alias.collision",
      subjectType: "supplier",
      subjectId: supplierId,
      detail: { resolvedTo: alias, reason: "trade name already has a live alias on this domain" },
    });
  }

  // ---- the write
  try {
    await client.createEmailForwarding(domain, alias, supplier.destination);
  } catch (err: any) {
    db.recordEvent({
      actor: deps.actor,
      action: "identity.mint.failed",
      subjectType: "supplier",
      subjectId: supplierId,
      api: trace(client),
      detail: { alias, error: `${err?.name}: ${err?.message}` },
    });
    throw err;
  }
  const createTrace = trace(client);

  // ---- the read-back we do not control. Do not trust the 201.
  const list = await client.listEmailForwardings(domain);
  const found = (list.emailForwarding ?? []).find(
    (f) => f.emailBox?.toLowerCase() === alias.toLowerCase(),
  );
  const readTrace = trace(client);
  if (!found) {
    db.recordEvent({
      actor: deps.actor,
      action: "identity.mint.readback_failed",
      subjectType: "supplier",
      subjectId: supplierId,
      api: readTrace,
      detail: { alias, reason: "create was accepted but the alias is absent from the list" },
    });
    throw new ReadBackFailure(
      `name.com accepted the forwarding for ${alias}@${domain} but it is absent from ` +
        `${PATHS.emailForwardingsList(domain)}. Not recording it as live.`,
      { alias, domain },
    );
  }
  const destinationMatches = found.emailTo === supplier.destination;

  const identity = db.recordMintedIdentity(
    { supplierId, domain, alias, destination: supplier.destination },
    deps.actor,
    createTrace,
    {
      address: `${alias}@${domain}`,
      to: supplier.destination,
      aliasWasSuffixed,
      readBack: {
        op: `GET ${PATHS.emailForwardingsList(domain)}`,
        httpStatus: readTrace.status,
        present: true,
        destinationMatches,
      },
    },
  );

  return {
    identity,
    address: `${alias}@${domain}`,
    aliasWasSuffixed,
    readBack: { present: true, destinationMatches },
  };
}

// ------------------------------------------------------------------ revoke

export interface RevokeResult {
  identityId: number;
  address: string;
  readBack: { absent: true };
}

/**
 * Deletes the forwarding, then lists forwardings again and confirms absence.
 * The database is only updated once the API agrees the identity is gone —
 * because the bounce is the proof, and the bounce depends on the record being
 * actually deleted, not on the DELETE having returned 200.
 */
export async function revoke(deps: IdentityDeps, identityId: number): Promise<RevokeResult> {
  const { db, client } = deps;
  const identity = db.getIdentity(identityId);
  if (!identity) throw new Error(`identity ${identityId} not found`);
  if (identity.status !== "live") {
    throw new Error(`identity ${identityId} is ${identity.status}, not live`);
  }
  const { domain, alias } = identity;

  try {
    await client.deleteEmailForwarding(domain, alias);
  } catch (err: any) {
    db.recordEvent({
      actor: deps.actor,
      action: "identity.revoke.failed",
      subjectType: "identity",
      subjectId: identityId,
      api: trace(client),
      detail: { alias, error: `${err?.name}: ${err?.message}` },
    });
    throw err;
  }
  const deleteTrace = trace(client);

  const list = await client.listEmailForwardings(domain);
  const stillThere = (list.emailForwarding ?? []).some(
    (f) => f.emailBox?.toLowerCase() === alias.toLowerCase(),
  );
  const readTrace = trace(client);
  if (stillThere) {
    db.recordEvent({
      actor: deps.actor,
      action: "identity.revoke.readback_failed",
      subjectType: "identity",
      subjectId: identityId,
      api: readTrace,
      detail: { alias, reason: "delete was accepted but the alias is still in the list" },
    });
    throw new ReadBackFailure(
      `name.com accepted the delete of ${alias}@${domain} but it is still present in ` +
        `${PATHS.emailForwardingsList(domain)}. Not recording it as revoked.`,
      { alias, domain },
    );
  }

  db.recordRevokedIdentity(identityId, deps.actor, deleteTrace, {
    address: `${alias}@${domain}`,
    readBack: {
      op: `GET ${PATHS.emailForwardingsList(domain)}`,
      httpStatus: readTrace.status,
      absent: true,
    },
  });

  return { identityId, address: `${alias}@${domain}`, readBack: { absent: true } };
}

// ------------------------------------------------- edge case 2: destination

/**
 * The supplier changes the inbox they read. The alias is untouched, so every
 * delivery slip already printed stays correct. That is the point of the design.
 */
export async function updateDestination(
  deps: IdentityDeps,
  identityId: number,
  newDestination: string,
): Promise<{ address: string; destination: string }> {
  const { db, client } = deps;
  const identity = db.getIdentity(identityId);
  if (!identity) throw new Error(`identity ${identityId} not found`);
  if (identity.status !== "live") {
    throw new Error(`identity ${identityId} is ${identity.status}, not live`);
  }
  const { domain, alias } = identity;

  await client.updateEmailForwarding(domain, alias, newDestination);
  const writeTrace = trace(client);

  const list = await client.listEmailForwardings(domain);
  const found = (list.emailForwarding ?? []).find(
    (f) => f.emailBox?.toLowerCase() === alias.toLowerCase(),
  );
  if (!found || found.emailTo !== newDestination) {
    db.recordEvent({
      actor: deps.actor,
      action: "identity.destination.readback_failed",
      subjectType: "identity",
      subjectId: identityId,
      api: trace(client),
      detail: { alias, wanted: newDestination, observed: found?.emailTo ?? null },
    });
    throw new ReadBackFailure(
      `Destination for ${alias}@${domain} reads back as ${found?.emailTo ?? "absent"}, ` +
        `not ${newDestination}.`,
      { alias, domain },
    );
  }

  db.recordDestinationChange(identityId, newDestination, deps.actor, writeTrace);
  return { address: `${alias}@${domain}`, destination: newDestination };
}
