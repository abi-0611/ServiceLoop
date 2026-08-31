import {
  migrateShopConfig,
  SHOP_CONFIG_VERSION,
  ShopConfigSchema,
  type ShopConfig,
} from '@serviceloop/config';
import {
  type Clock,
  deepMerge,
  diffPaths,
  type EventEnvelope,
  type FieldDiff,
  type PlainObject,
  systemClock,
  uuidv7,
  ValidationError,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';

/**
 * Guardrail config engine (phase 1.6).
 *
 * Reads migrate old documents forward; writes go through the single
 * `validateAndPatch` path, which deep-merges the patch, revalidates the *whole*
 * document, and audits the field-level diff with its actor. There is no other
 * way to change a guardrail.
 */

export interface GuardrailServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly store: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export interface ConfigReadResult {
  readonly config: ShopConfig;
  readonly migratedFrom: number | null;
}

export interface ConfigPatchResult {
  readonly config: ShopConfig;
  readonly diffs: readonly FieldDiff[];
  readonly auditEventId: string | null;
}

export class GuardrailService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: GuardrailServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async get(shopId: string): Promise<ConfigReadResult> {
    return this.deps.uow.transaction(async (tx) => this.readInTransaction(tx, shopId));
  }

  /**
   * The only write path. Rejects an invalid patch with field-level errors and
   * never partially applies one.
   */
  async validateAndPatch(
    shopId: string,
    patch: PlainObject,
    actor: Actor,
    traceId: string,
  ): Promise<ConfigPatchResult> {
    return this.deps.uow.transaction(async (tx) => {
      const current = await this.readInTransaction(tx, shopId);

      const candidate = deepMerge(current.config as unknown as PlainObject, patch);
      candidate['configVersion'] = SHOP_CONFIG_VERSION;

      const parsed = ShopConfigSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ValidationError('Guardrail configuration patch rejected', {
          fieldErrors: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      const next = parsed.data;
      const diffs = diffPaths(
        current.config as unknown as PlainObject,
        next as unknown as PlainObject,
      );

      if (diffs.length === 0 && current.migratedFrom === null) {
        return { config: next, diffs, auditEventId: null };
      }

      await this.deps.store.save(tx, shopId, next, actor.id);

      const auditRecord = await this.deps.audit.append(tx, {
        shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'shop_config.updated',
        entityType: 'ShopConfig',
        entityId: shopId,
        payload: {
          configVersion: next.configVersion,
          migratedFrom: current.migratedFrom,
          diffs: diffs.map((diff) => ({
            path: diff.path,
            before: diff.before ?? null,
            after: diff.after ?? null,
          })),
        },
        traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'shop_config.updated',
        occurredAt: this.clock.now().toISOString(),
        shopId,
        traceId,
        payload: {
          configVersion: next.configVersion,
          changedPaths: diffs.map((diff) => diff.path),
          actor: { type: actor.type, id: actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return { config: next, diffs, auditEventId: auditRecord.id };
    });
  }

  private async readInTransaction(tx: Tx, shopId: string): Promise<ConfigReadResult> {
    const stored = await this.deps.store.load(tx, shopId);
    const timezone = (await this.deps.store.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    const outcome = migrateShopConfig(stored?.raw ?? {}, timezone);
    return { config: outcome.config, migratedFrom: outcome.migratedFrom };
  }
}
