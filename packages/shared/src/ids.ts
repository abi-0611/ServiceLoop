/**
 * UUIDv7 — time-ordered identifiers.
 *
 * Every primary key in ServiceLoop is a UUIDv7 so that rows are naturally
 * ordered by creation time (good B-tree locality, and audit/outbox scans read
 * in insertion order) while remaining globally unique and non-guessable.
 *
 * Layout (RFC 9562):
 *   48 bits  unix_ts_ms
 *    4 bits  version (0b0111)
 *   12 bits  rand_a — used here as a monotonic counter within the same ms
 *    2 bits  variant (0b10)
 *   62 bits  rand_b
 */

const MAX_COUNTER = 0x0fff;

let lastTimestampMs = -1;
let counter = 0;

/**
 * Web Crypto rather than `node:crypto`: this module is imported by the console's
 * client bundle as well as by the server, and `globalThis.crypto` is present in
 * Node 18+ and every supported browser.
 */
function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function seedCounter(): number {
  // Seed in the lower half so a burst inside one millisecond cannot overflow
  // into the next millisecond's ordering.
  const bytes = randomBytes(2);
  return (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) & 0x07ff;
}

export function uuidv7(nowMs: number = Date.now()): string {
  const ts = Math.max(nowMs, lastTimestampMs);

  if (ts === lastTimestampMs) {
    counter += 1;
    if (counter > MAX_COUNTER) {
      // Counter exhausted inside a single millisecond: borrow the next one.
      lastTimestampMs = ts + 1;
      counter = seedCounter();
      return uuidv7(lastTimestampMs);
    }
  } else {
    lastTimestampMs = ts;
    counter = seedCounter();
  }

  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  const rand = randomBytes(8);
  bytes[8] = ((rand[0] ?? 0) & 0x3f) | 0x80;
  for (let i = 1; i < 8; i += 1) {
    bytes[8 + i] = rand[i] ?? 0;
  }

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Extracts the embedded millisecond timestamp from a UUIDv7. */
export function uuidv7Timestamp(id: string): number | null {
  if (!isUuid(id)) return null;
  const hex = id.replace(/-/g, '');
  if (hex[12] !== '7') return null;
  return Number.parseInt(hex.slice(0, 12), 16);
}

/**
 * Entity id aliases. These are documentation-grade aliases (not branded types)
 * so that repository rows returned by Drizzle flow through the domain without
 * casts; the DB enforces referential integrity.
 */
export type Uuid = string;
export type ShopId = Uuid;
export type StaffId = Uuid;
export type CustomerId = Uuid;
export type VehicleId = Uuid;
export type JobCardId = Uuid;
export type WorkItemId = Uuid;
export type EstimateId = Uuid;
export type MediaAssetId = Uuid;
export type ApprovalRequestId = Uuid;
export type ConversationId = Uuid;
export type AuditEventId = Uuid;
export type OutboxEventId = Uuid;
