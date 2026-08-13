import type { ShopConfig } from '@serviceloop/config';
import type { AuditActorType, JobCardState, Paise, WorkItemState } from '@serviceloop/shared';

/** Who caused a change. Every audit row and outbox event carries one. */
export interface Actor {
  readonly type: AuditActorType;
  readonly id: string | null;
  readonly displayName?: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null, displayName: 'system' };

export interface JobCardSnapshot {
  readonly id: string;
  readonly shopId: string;
  readonly state: JobCardState;
  readonly version: number;
}

export interface WorkItemSnapshot {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly state: WorkItemState;
  readonly requiresApproval: boolean;
}

/**
 * Everything a guard is allowed to look at. Guards receive this object and
 * nothing else — no repositories, no clock of their own — which keeps them
 * pure and table-testable.
 */
export interface JobCardGuardContext {
  readonly card: JobCardSnapshot;
  readonly workItems: readonly WorkItemSnapshot[];
  readonly config: ShopConfig;
  /** Invoice total minus payments received. Zero when nothing is owed. */
  readonly outstandingBalancePaise: Paise;
  readonly now: Date;
}

export type GuardResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

export const ALLOWED: GuardResult = { allowed: true };

export function refuse(code: string, reason: string): GuardResult {
  return { allowed: false, code, reason };
}
