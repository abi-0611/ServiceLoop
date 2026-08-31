import { BadRequestException, Controller, Inject, Post } from '@nestjs/common';
import type { LoopRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import { formatPaise } from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody } from '../common/zod';
import { LOOP_RUNTIME } from '../infra/tokens';

/**
 * The gate pass (phase 4.10).
 *
 * `verify` is the gate person's screen, and its whole job is to be readable in
 * three seconds on a phone in the rain: one boolean for the barrier, one
 * sentence for why, and the card summary so they can check the vehicle in front
 * of them is the one on the screen.
 *
 * Both the scanned token and the typed code arrive here. The service checks the
 * signature before touching a row, so a gate being probed costs no queries.
 */

const IssueBody = z.object({
  jobCardId: z.string().uuid(),
  /**
   * Releasing a vehicle with a balance outstanding.
   *
   * A shop that lets a regular settle on Monday is behaving normally; a shop
   * that cannot record having done so ends up with an untracked debt and
   * nobody's name against it. Owner-only, and the reason is mandatory.
   */
  overrideReason: z.string().min(5).max(300).optional(),
});

const VerifyBody = z
  .object({
    token: z.string().min(1).max(2000).optional(),
    code: z.string().min(1).max(32).optional(),
  })
  .refine((value) => value.token !== undefined || value.code !== undefined, {
    message: 'Present either a scanned token or a typed code',
  });

const RevokeBody = z.object({
  gatePassId: z.string().uuid(),
  reason: z.string().min(5).max(300),
});

@Controller('gate-pass')
export class GatePassController {
  constructor(@Inject(LOOP_RUNTIME) private readonly loop: LoopRuntime<Tx>) {}

  /**
   * Issues a pass. Refuses while money is outstanding unless an owner
   * overrides — which is why the override is OWNER-only while issuing is not.
   */
  @Post('issue')
  @Roles('OWNER', 'ADVISOR')
  async issue(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(IssueBody) body: z.infer<typeof IssueBody>,
  ) {
    if (body.overrideReason !== undefined && staff.role !== 'OWNER') {
      throw new BadRequestException({
        code: 'OVERRIDE_REQUIRES_OWNER',
        detail: 'Only an owner may release a vehicle with a balance outstanding',
      });
    }

    const result = await this.loop.gatePasses.issue({
      shopId: staff.shopId,
      jobCardId: body.jobCardId,
      ...(body.overrideReason === undefined
        ? {}
        : { overrideReason: body.overrideReason, overrideByStaffId: staff.staffId }),
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    if (!result.ok) throw new BadRequestException({ code: result.code, detail: result.reason });

    return {
      gatePassId: result.gatePassId,
      code: result.code,
      // The token is returned once, at issue, so the console can render the QR.
      // It is not recoverable afterwards — only its hash was stored.
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      reused: result.reused,
    };
  }

  /**
   * The verify screen.
   *
   * Answers 200 whatever the verdict. A rejected pass is not an HTTP error —
   * it is the answer to the question the gate person asked, and turning it into
   * a 4xx would make the console show a stack trace where it should show a red
   * light and a sentence.
   */
  @Post('verify')
  @Roles('OWNER', 'ADVISOR', 'TECHNICIAN')
  async verify(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(VerifyBody) body: z.infer<typeof VerifyBody>,
  ) {
    const outcome = await this.loop.gatePasses.verify({
      shopId: staff.shopId,
      token: body.token ?? null,
      code: body.code ?? null,
      staffId: staff.staffId,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    return {
      result: outcome.result,
      // The one thing the barrier depends on.
      allow: outcome.result === 'VALID',
      detail: outcome.detail,
      gatePassId: outcome.gatePassId,
      jobCardId: outcome.jobCardId,
      summary:
        outcome.summary === null
          ? null
          : {
              code: outcome.summary.code,
              registration: outcome.summary.registration,
              vehicle: outcome.summary.vehicleLabel,
              customerName: outcome.summary.customerName,
              state: outcome.summary.state,
              balance: formatPaise(outcome.summary.balancePaise),
              balancePaise: outcome.summary.balancePaise,
            },
    };
  }

  @Post('revoke')
  @Roles('OWNER')
  async revoke(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(RevokeBody) body: z.infer<typeof RevokeBody>,
  ) {
    const revoked = await this.loop.gatePasses.revoke({
      shopId: staff.shopId,
      gatePassId: body.gatePassId,
      reason: body.reason,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    if (!revoked) {
      throw new BadRequestException({
        code: 'NO_GATE_PASS',
        detail: 'That gate pass is not in this shop',
      });
    }

    return { gatePassId: body.gatePassId, revoked: true };
  }
}
