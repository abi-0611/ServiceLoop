import { Controller, Get, Inject, Patch } from '@nestjs/common';
import type { ShopConfig } from '@serviceloop/config';
import type { Tx } from '@serviceloop/db';
import type { GuardrailService } from '@serviceloop/domain';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody } from '../common/zod';
import { GUARDRAIL_SERVICE } from '../infra/tokens';

/**
 * Guardrail configuration (phase 1.6).
 *
 * Reads are open to any authenticated staff member — an advisor needs to know
 * the quiet hours they are working under. Writes are OWNER-only and go through
 * `validateAndPatch`, which validates the whole document and audits the diff.
 */

const PatchSchema = z.record(z.unknown());

export interface GuardrailReadResponse {
  readonly config: ShopConfig;
  readonly migratedFrom: number | null;
  readonly editable: boolean;
}

export interface GuardrailPatchResponse {
  readonly config: ShopConfig;
  readonly changed: Array<{ path: string; before: unknown; after: unknown }>;
  readonly auditEventId: string | null;
}

@Controller('config')
export class ConfigController {
  constructor(@Inject(GUARDRAIL_SERVICE) private readonly guardrails: GuardrailService<Tx>) {}

  @Get('guardrails')
  async read(@CurrentStaff() staff: AuthenticatedStaff): Promise<GuardrailReadResponse> {
    const result = await this.guardrails.get(staff.shopId);
    return { ...result, editable: staff.role === 'OWNER' };
  }

  @Roles('OWNER')
  @Patch('guardrails')
  async patch(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(PatchSchema) body: Record<string, unknown>,
  ): Promise<GuardrailPatchResponse> {
    const result = await this.guardrails.validateAndPatch(
      staff.shopId,
      body,
      { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      currentTraceId(),
    );

    return {
      config: result.config,
      changed: result.diffs.map((diff) => ({
        path: diff.path,
        before: diff.before ?? null,
        after: diff.after ?? null,
      })),
      auditEventId: result.auditEventId,
    };
  }
}
