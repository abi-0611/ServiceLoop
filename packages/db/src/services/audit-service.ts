import {
  type AuditAppendInput,
  type AuditAppender,
  type AuditChainEntry,
  type AuditRecord,
  AuditChainError,
  type ChainVerificationResult,
  computeAuditHash,
  GENESIS_HASH,
  verifyAuditChain,
} from '@serviceloop/domain';
import { uuidv7 } from '@serviceloop/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Database, Executor, Tx } from '../client';
import { auditEvents } from '../schema';

/**
 * Hash-chained audit log over Postgres (phase 1.7).
 *
 * The chain head (seq + hash) is cached in Redis per shop so an append is O(1);
 * the database remains the truth, and a cache miss or a stale head falls back
 * to a `SELECT … ORDER BY seq DESC LIMIT 1` inside the caller's transaction.
 * The unique `(shop_id, seq)` index is the real serialisation point: if two
 * transactions compute the same seq, exactly one commits.
 */

const HEAD_KEY = (shopId: string) => `audit:head:${shopId}`;
const HEAD_TTL_SECONDS = 60 * 60 * 24;

interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

export class AuditService implements AuditAppender<Tx> {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis | null = null,
  ) {}

  async append(tx: Tx, input: AuditAppendInput): Promise<AuditRecord> {
    const head = await this.loadHead(tx, input.shopId);
    const seq = head.seq + 1;
    const createdAt = new Date();

    const facts = {
      shopId: input.shopId,
      seq,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      createdAt: createdAt.toISOString(),
    };
    const hash = computeAuditHash(head.hash, facts);
    const id = uuidv7();

    await tx.insert(auditEvents).values({
      id,
      shopId: input.shopId,
      seq,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload as Record<string, unknown>,
      prevHash: head.hash,
      hash,
      traceId: input.traceId,
      createdAt,
    });

    await this.cacheHead(input.shopId, { seq, hash });

    return { id, seq, hash, prevHash: head.hash, createdAt };
  }

  /**
   * Walks the whole chain for a shop and reports the exact break index.
   * Reads outside any caller transaction so it sees committed truth only.
   */
  async verifyChain(
    shopId: string,
    executor: Executor = this.db,
  ): Promise<ChainVerificationResult> {
    const rows = await executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.shopId, shopId))
      .orderBy(asc(auditEvents.seq));

    return verifyAuditChain(rows.map(toChainEntry));
  }

  /**
   * Cheap integrity probe over the newest `count` entries: recomputes each
   * hash and checks the links between them, without walking the whole chain.
   * Workers run this on every event so tampering is noticed in minutes rather
   * than at the next full verification.
   */
  async verifyTail(
    shopId: string,
    count = 25,
    executor: Executor = this.db,
  ): Promise<ChainVerificationResult> {
    const rows = await executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.shopId, shopId))
      .orderBy(sql`${auditEvents.seq} desc`)
      .limit(count);

    const entries = rows.map(toChainEntry).reverse();
    if (entries.length === 0) {
      return {
        valid: true,
        entriesChecked: 0,
        brokenAtIndex: null,
        brokenEventId: null,
        reason: null,
      };
    }

    let expectedPrev: string | null = null;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;

      if (expectedPrev !== null && entry.prevHash !== expectedPrev) {
        return {
          valid: false,
          entriesChecked: entries.length,
          brokenAtIndex: index,
          brokenEventId: entry.id,
          reason: `Broken link at seq ${entry.seq}: recorded prevHash ${entry.prevHash}, previous entry hashed to ${expectedPrev}`,
        };
      }

      const recomputed = computeAuditHash(entry.prevHash, {
        shopId: entry.shopId,
        seq: entry.seq,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        payload: entry.payload,
        createdAt: entry.createdAt,
      });
      if (recomputed !== entry.hash) {
        return {
          valid: false,
          entriesChecked: entries.length,
          brokenAtIndex: index,
          brokenEventId: entry.id,
          reason: `Content tampered at seq ${entry.seq}: stored hash ${entry.hash}, recomputed ${recomputed}`,
        };
      }

      expectedPrev = entry.hash;
    }

    return {
      valid: true,
      entriesChecked: entries.length,
      brokenAtIndex: null,
      brokenEventId: null,
      reason: null,
    };
  }

  async listForEntity(
    shopId: string,
    entityType: string,
    entityId: string,
    executor: Executor = this.db,
  ): Promise<AuditChainEntry[]> {
    const rows = await executor
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.shopId} = ${shopId} and ${auditEvents.entityType} = ${entityType} and ${auditEvents.entityId} = ${entityId}`,
      )
      .orderBy(asc(auditEvents.seq));

    return rows.map(toChainEntry);
  }

  /** Recomputes the Redis head from the database. Used after a restore. */
  async refreshHeadCache(shopId: string): Promise<ChainHead> {
    const head = await this.readHeadFromDb(this.db, shopId);
    await this.cacheHead(shopId, head);
    return head;
  }

  private async loadHead(executor: Executor, shopId: string): Promise<ChainHead> {
    const cached = await this.readHeadFromCache(shopId);
    const fromDb = await this.readHeadFromDb(executor, shopId);

    if (cached !== null && cached.seq !== fromDb.seq) {
      // A divergent cache means someone wrote outside this process's view.
      // The database wins, and the cache is corrected below.
      await this.cacheHead(shopId, fromDb);
    }
    return fromDb;
  }

  private async readHeadFromDb(executor: Executor, shopId: string): Promise<ChainHead> {
    const [row] = await executor
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.shopId, shopId))
      .orderBy(sql`${auditEvents.seq} desc`)
      .limit(1);

    if (row === undefined) return { seq: 0, hash: GENESIS_HASH };
    if (row.hash.length !== 64) {
      throw new AuditChainError(`Chain head for shop ${shopId} has a malformed hash`, { shopId });
    }
    return { seq: Number(row.seq), hash: row.hash };
  }

  private async readHeadFromCache(shopId: string): Promise<ChainHead | null> {
    if (this.redis === null) return null;
    const raw = await this.redis.get(HEAD_KEY(shopId));
    if (raw === null) return null;
    const [seqPart, hashPart] = raw.split(':');
    if (seqPart === undefined || hashPart === undefined) return null;
    const seq = Number(seqPart);
    return Number.isFinite(seq) ? { seq, hash: hashPart } : null;
  }

  private async cacheHead(shopId: string, head: ChainHead): Promise<void> {
    if (this.redis === null) return;
    await this.redis.set(HEAD_KEY(shopId), `${head.seq}:${head.hash}`, 'EX', HEAD_TTL_SECONDS);
  }
}

type AuditRow = typeof auditEvents.$inferSelect;

function toChainEntry(row: AuditRow): AuditChainEntry {
  return {
    id: row.id,
    shopId: row.shopId,
    seq: Number(row.seq),
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    prevHash: row.prevHash,
    hash: row.hash,
  };
}
