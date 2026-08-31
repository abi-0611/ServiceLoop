import type { ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  t,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type GatePassVerifyResult,
  type JobCardState,
  type Paise,
} from '@serviceloop/shared';
import type { JobCardContextReader } from '../agent/ports';
import type { Actor } from '../job-card/context';
import type { ConversationStore } from '../messaging/ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import { formatLocalTime } from '../status/status-comms';
import { hashToken, signGatePass, verifyGatePassToken } from './gate-pass-token';
import type {
  GatePassRecord,
  GatePassSecretProvider,
  GatePassStore,
  GeneratedMediaWriter,
  PaymentStore,
  QrRenderer,
} from './ports';

/**
 * The gate pass (phase 4.10).
 *
 * The last thing between a repaired vehicle and the road. Two audiences and two
 * failure modes, and the design follows from taking both seriously:
 *
 *   - **The customer** gets a QR and a six-character code in WhatsApp. The code
 *     exists because a phone screen in the rain at 19:00 is not a reliable
 *     scanning target, and a customer standing at a barrier unable to leave is
 *     a worse outcome than a slightly less elegant credential.
 *   - **The gate person** gets green or red, and when it is red, *which* red.
 *     "Invalid" tells them nothing; "this pass expired at 18:00 yesterday" tells
 *     them to call the advisor.
 *
 * Every verification is audited, including the failures. A forged code has no
 * row to attach to, so the audit entry is the only record that somebody tried
 * — which is exactly when you want one.
 */

export interface GatePassServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly passes: GatePassStore<Tx>;
  readonly payments: PaymentStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly secret: GatePassSecretProvider;
  /**
   * Turns the token into something a phone camera can read.
   *
   * Optional: a deployment without it sends the six-character code alone, which
   * still works at the gate. What it loses is the case the QR exists for — a
   * gate person on a busy evening reading six characters off a stranger's
   * cracked screen.
   */
  readonly qr?: QrRenderer;
  /** Stores the rendered QR so the channel has a MediaAsset to send. */
  readonly media?: GeneratedMediaWriter;
  readonly clock?: Clock;
}

export type IssueGatePassResult =
  | {
      readonly ok: true;
      readonly gatePassId: string;
      readonly code: string;
      /** The signed token. Sent to the customer and stored nowhere. */
      readonly token: string;
      readonly expiresAt: Date;
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface VerifyResult {
  readonly result: GatePassVerifyResult;
  readonly gatePassId: string | null;
  readonly jobCardId: string | null;
  /** What the gate person's screen shows when the light is green. */
  readonly summary: {
    readonly code: string;
    readonly registration: string;
    readonly vehicleLabel: string;
    readonly customerName: string;
    readonly state: JobCardState;
    readonly balancePaise: Paise;
  } | null;
  readonly detail: string;
}

export class GatePassService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: GatePassServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * The card's live pass, if it has one.
   *
   * The stored row only — never the token, which was returned once at issue and
   * is not recoverable from the hash that was kept.
   */
  async activeForCard(shopId: string, jobCardId: string): Promise<GatePassRecord | null> {
    return this.deps.uow.transaction((tx) =>
      this.deps.passes.findActiveForCard(tx, shopId, jobCardId),
    );
  }

  /**
   * Issues a pass, refusing while money is outstanding unless an owner
   * overrides with a reason.
   *
   * The override is not a loophole — it is the shop's own decision, recorded.
   * A workshop that lets a regular take their car and settle on Monday is
   * behaving normally; a workshop that cannot record having done so ends up
   * with an untracked debt and no idea who authorised it.
   */
  async issue(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly overrideReason?: string | null;
    readonly overrideByStaffId?: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<IssueGatePassResult> {
    const now = this.clock.now();

    const context = await this.deps.uow.transaction(async (tx) => {
      const existing = await this.deps.passes.findActiveForCard(tx, input.shopId, input.jobCardId);
      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      if (card === null) return null;
      const config = await this.deps.loadConfig(tx, input.shopId);
      const payment = await this.deps.payments.findOpenForCard(tx, input.shopId, input.jobCardId);
      const shopName = (await this.deps.directory.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        card.customerId,
        'WHATSAPP',
      );
      return { existing, card, config, payment, shopName, conversation };
    });

    if (context === null) {
      return { ok: false, code: 'NO_JOB_CARD', reason: 'That job card is not in this shop' };
    }
    if (context.existing !== null && context.existing.expiresAt.getTime() > now.getTime()) {
      return {
        ok: true,
        gatePassId: context.existing.id,
        code: context.existing.code,
        // The token is not recoverable from the row by design — only its hash
        // was stored. A customer who lost the message needs a fresh pass, which
        // is a revoke-and-reissue, not a re-read.
        token: '',
        expiresAt: context.existing.expiresAt,
        reused: true,
      };
    }

    const balancePaise =
      context.payment === null ? 0 : context.payment.amountPaise - context.payment.amountPaidPaise;
    const override = input.overrideReason?.trim() ?? '';

    if (balancePaise > 0 && override.length === 0) {
      return {
        ok: false,
        code: 'BALANCE_OUTSTANDING',
        reason: `There is still ${balancePaise} paise outstanding on this card. An owner can release the vehicle by supplying a reason.`,
      };
    }

    const gatePassId = uuidv7();
    const signed = signGatePass(
      {
        gatePassId,
        jobCardId: input.jobCardId,
        shopId: input.shopId,
        exp: Math.floor(
          (now.getTime() + context.config.payments.gatePassTtlMinutes * 60_000) / 1000,
        ),
      },
      this.deps.secret(),
    );

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.passes.insert(tx, {
        id: gatePassId,
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        customerId: context.card.customerId,
        code: signed.code,
        tokenHash: signed.tokenHash,
        status: 'ISSUED',
        issuedAt: now,
        expiresAt: signed.expiresAt,
        usedAt: null,
        verifiedByStaffId: null,
        overrideReason: override.length === 0 ? null : override,
        overrideByStaffId: input.overrideByStaffId ?? null,
        verificationAttempts: 0,
        lastVerifyResult: null,
        messageId: null,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'gate_pass.issued',
        entityType: 'gate_pass',
        entityId: gatePassId,
        payload: {
          jobCardId: input.jobCardId,
          code: signed.code,
          expiresAt: signed.expiresAt.toISOString(),
          balancePaise,
          overrideReason: override.length === 0 ? null : override,
          overrideByStaffId: input.overrideByStaffId ?? null,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'gate_pass.issued',
        payload: {
          gatePassId,
          jobCardId: input.jobCardId,
          code: signed.code,
          expiresAt: signed.expiresAt.toISOString(),
          overrideReason: override.length === 0 ? null : override,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    if (context.conversation !== null) {
      const language = context.card.customerLanguage;
      const body =
        override.length === 0
          ? t(language, 'gatepass.issued', {
              vehicle: context.card.vehicleLabel,
              code: signed.code,
              expires: formatLocalTime(signed.expiresAt, context.config.quietHours.timezone),
            })
          : t(language, 'gatepass.override', {
              shopName: context.shopName,
              vehicle: context.card.vehicleLabel,
              code: signed.code,
            });

      // The code travels in the caption, not only in the image. A customer
      // whose phone will not display the picture — a slow connection, a
      // downgraded network, a data saver — must still be able to read out six
      // characters at the gate.
      const qr = await this.renderQr(input.shopId, input.jobCardId, signed.token, input.traceId);

      const outcome = await this.deps.gate.send({
        shopId: input.shopId,
        conversationId: context.conversation.id,
        customerId: context.card.customerId,
        purpose: 'SERVICE',
        content:
          qr === null
            ? { kind: 'text', body }
            : {
                kind: 'media',
                mediaId: qr.mediaId,
                mediaKind: 'PHOTO',
                contentType: qr.contentType,
                bytes: qr.bytes,
                caption: body,
              },
        actor: input.actor,
        traceId: input.traceId,
        flow: 'delivery',
        language,
        jobCardId: input.jobCardId,
        templated: true,
        isAcknowledgement: true,
      });

      await this.deps.uow.transaction((tx) =>
        this.deps.passes.attachMessage(tx, gatePassId, outcome.messageId),
      );
    }

    return {
      ok: true,
      gatePassId,
      code: signed.code,
      token: signed.token,
      expiresAt: signed.expiresAt,
      reused: false,
    };
  }

  /**
   * The gate person's screen.
   *
   * Accepts either a scanned token or a typed code. A token is checked for
   * signature and expiry *before* any row is read, so a gate being probed costs
   * no queries; a code has no signature and is therefore only ever a lookup
   * key, scoped to the shop the verifying staff member belongs to.
   */
  async verify(input: {
    readonly shopId: string;
    readonly token?: string | null;
    readonly code?: string | null;
    readonly staffId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<VerifyResult> {
    const now = this.clock.now();
    const presented = (input.token ?? input.code ?? '').trim();

    if (presented.length === 0) {
      return this.recordVerification(input, null, 'UNKNOWN', 'Nothing was presented', now);
    }

    let gatePassId: string | null = null;
    let lookupCode: string | null = null;

    if (input.token != null && input.token.trim().length > 0) {
      const verdict = verifyGatePassToken(input.token.trim(), this.deps.secret(), now);
      if (!verdict.ok) {
        return this.recordVerification(
          input,
          null,
          verdict.result,
          verdict.result === 'EXPIRED'
            ? 'This pass has expired'
            : 'That code was not issued by this shop',
          now,
        );
      }
      if (verdict.claims.shopId !== input.shopId) {
        // A validly signed pass for a different tenant. Same answer as a
        // forgery, on purpose: confirming it exists elsewhere would leak that
        // another shop on this installation has that vehicle.
        return this.recordVerification(
          input,
          null,
          'FORGED',
          'That code was not issued by this shop',
          now,
        );
      }
      gatePassId = verdict.claims.gatePassId;
    } else {
      lookupCode = presented.toUpperCase();
    }

    const found = await this.deps.uow.transaction(async (tx) =>
      gatePassId === null
        ? this.deps.passes.lockByCode(tx, input.shopId, lookupCode as string)
        : this.deps.passes.lockById(tx, input.shopId, gatePassId),
    );

    if (found === null) {
      return this.recordVerification(input, null, 'UNKNOWN', 'No pass matches that code', now);
    }

    // The token proves the pass was minted here; the row is what says whether
    // it is still good. Both checks are needed and neither replaces the other.
    if (input.token != null && input.token.trim().length > 0) {
      if (hashToken(input.token.trim()) !== found.tokenHash) {
        return this.recordVerification(
          input,
          found,
          'FORGED',
          'That token does not match the pass on file',
          now,
        );
      }
    }

    if (found.status === 'REVOKED') {
      return this.recordVerification(input, found, 'REVOKED', 'This pass was revoked', now);
    }
    if (found.status === 'USED') {
      return this.recordVerification(
        input,
        found,
        'ALREADY_USED',
        `This pass was already used at ${found.usedAt?.toISOString() ?? 'an earlier time'}`,
        now,
      );
    }
    if (found.expiresAt.getTime() <= now.getTime()) {
      return this.recordVerification(input, found, 'EXPIRED', 'This pass has expired', now);
    }

    return this.recordVerification(input, found, 'VALID', 'Vehicle may leave', now);
  }

  /**
   * The token as a picture, stored so the channel can send it.
   *
   * Returns null — rather than throwing — whenever the renderer is absent or
   * fails. The pass is already issued and already valid at that point; letting
   * a raster library decide whether a customer can collect their car would be
   * the tail wagging the dog. They get the code, which is what the gate screen
   * accepts anyway.
   */
  private async renderQr(
    shopId: string,
    jobCardId: string,
    token: string,
    traceId: string,
  ): Promise<{
    readonly mediaId: string;
    readonly bytes: Buffer;
    readonly contentType: string;
  } | null> {
    const renderer = this.deps.qr;
    const media = this.deps.media;
    if (renderer === undefined || media === undefined) return null;

    try {
      const image = await renderer.render(token);
      const stored = await media.store({
        shopId,
        jobCardId,
        contentType: image.contentType,
        bytes: image.bytes,
        filename: 'gate-pass.png',
        caption: 'Gate pass',
        traceId,
      });
      return { mediaId: stored.mediaId, bytes: image.bytes, contentType: image.contentType };
    } catch {
      return null;
    }
  }

  async revoke(input: {
    readonly shopId: string;
    readonly gatePassId: string;
    readonly reason: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<boolean> {
    const now = this.clock.now();
    return this.deps.uow.transaction(async (tx) => {
      const pass = await this.deps.passes.lockById(tx, input.shopId, input.gatePassId);
      if (pass === null) return false;
      await this.deps.passes.revoke(tx, input.shopId, input.gatePassId, now);
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'gate_pass.revoked',
        entityType: 'gate_pass',
        entityId: input.gatePassId,
        payload: { jobCardId: pass.jobCardId, reason: input.reason },
        traceId: input.traceId,
      });
      return true;
    });
  }

  /**
   * Writes the verification and builds the answer.
   *
   * Every attempt lands in the audit chain — a repeatedly rejected code at a
   * gate is exactly the pattern nobody notices until they go looking, and by
   * then the chain is the only place it could have been.
   */
  private async recordVerification(
    input: {
      readonly shopId: string;
      readonly staffId: string | null;
      readonly actor: Actor;
      readonly traceId: string;
      readonly token?: string | null;
      readonly code?: string | null;
    },
    pass: GatePassRecord | null,
    result: GatePassVerifyResult,
    detail: string,
    now: Date,
  ): Promise<VerifyResult> {
    const summary =
      pass === null || result !== 'VALID'
        ? null
        : await this.deps.uow.transaction(async (tx) => {
            const card = await this.deps.cards.load(tx, input.shopId, pass.jobCardId);
            if (card === null) return null;
            const payment = await this.deps.payments.findOpenForCard(
              tx,
              input.shopId,
              pass.jobCardId,
            );
            return {
              code: card.code,
              registration: card.registration,
              vehicleLabel: card.vehicleLabel,
              customerName: card.customerName,
              state: card.state as JobCardState,
              balancePaise:
                payment === null ? 0 : payment.amountPaise - payment.amountPaidPaise,
            };
          });

    await this.deps.uow.transaction(async (tx) => {
      if (pass !== null) {
        await this.deps.passes.recordVerification(tx, {
          gatePassId: pass.id,
          result,
          staffId: input.staffId,
          markUsed: result === 'VALID',
          at: now,
        });
      }

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'gate_pass.verified',
        entityType: 'gate_pass',
        entityId: pass?.id ?? null,
        payload: {
          result,
          jobCardId: pass?.jobCardId ?? null,
          // The presented code, never the token: a token in the audit log is a
          // reusable credential sitting in an append-only table.
          presentedCode: pass?.code ?? input.code ?? null,
          verifiedByStaffId: input.staffId,
          detail,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'gate_pass.verified',
        payload: {
          gatePassId: pass?.id ?? null,
          jobCardId: pass?.jobCardId ?? null,
          code: pass?.code ?? input.code ?? '',
          result,
          verifiedByStaffId: input.staffId,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    return {
      result,
      gatePassId: pass?.id ?? null,
      jobCardId: pass?.jobCardId ?? null,
      summary,
      detail,
    };
  }
}
