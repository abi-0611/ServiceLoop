import type {
  AdvisorTaskInput,
  AdvisorTaskSnapshot,
  AdvisorTaskStore,
  AgentRunFinish,
  AgentRunRecord,
  AgentRunStore,
  AgentStepRecord,
  ApprovalSnapshot,
  ApprovalStore,
  BundleLine,
  BundleMedia,
  Claim,
  EscalationStore,
  EvidenceBundle,
  EvidenceBundleStore,
  JobCardContext,
  JobCardContextReader,
  PendingCandidate,
  PriceListReader,
  ReviewStore,
  ScheduledRung,
  SourceNote,
} from '@serviceloop/domain';
import type { LlmUsageRecord, LlmUsageSink } from '@serviceloop/adapters';
import type {
  AdvisorTaskStatus,
  AgentObjective,
  ApprovalStatus,
  CustomerDecision,
  EscalationRungType,
  EstimateLineKind,
  Language,
  MediaKind,
  Paise,
  ReviewAction,
} from '@serviceloop/shared';
import { formatPaise } from '@serviceloop/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { decryptPii } from '../crypto/pii';
import {
  advisorTasks,
  agentRuns,
  agentSteps,
  approvalRequests,
  escalations,
  evidenceBundles,
  llmUsage,
  messageReviews,
} from '../schema';

/**
 * Postgres implementations of the phase-3 ports.
 *
 * The in-memory versions in `@serviceloop/domain/testing` are the specification
 * these are written against — including the idempotency that the domain relies
 * on and that these get for free from unique indexes: a redelivered trigger
 * message cannot open a second agent run, a redelivered ladder event cannot
 * schedule a second rung, and a ladder rung cannot raise the same advisor task
 * twice.
 *
 * `ON CONFLICT DO NOTHING` is the shape that expresses that: it turns "already
 * exists" into a null return rather than an exception the caller has to
 * classify, which is what lets the domain treat duplication as an ordinary
 * outcome instead of an error path.
 */

/* -------------------------------------------------------------------------- *
 * LLM usage metering (3.1)
 * -------------------------------------------------------------------------- */

/**
 * The usage sink, over its own connection rather than a caller's transaction.
 *
 * Metering must not be able to roll back a customer's message, and it must not
 * hold a transaction open across a model call. `BestEffortUsageSink` wraps this
 * at the composition root so a failure here is logged and dropped.
 */
export class PgLlmUsageSink implements LlmUsageSink {
  constructor(private readonly executor: { insert: Tx['insert'] }) {}

  async record(usage: LlmUsageRecord): Promise<void> {
    await this.executor.insert(llmUsage).values({
      shopId: usage.shopId,
      taskClass: usage.taskClass,
      model: usage.model,
      driver: usage.driver,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: usage.latencyMs,
      attempts: usage.attempts,
      costUsdMicros: usage.costUsdMicros,
      errorKind: usage.errorKind,
      agentRunId: usage.agentRunId,
      promptHash: usage.promptHash,
      traceId: usage.traceId,
      createdAt: usage.at,
    });
  }
}

/* -------------------------------------------------------------------------- *
 * Agent runs and steps (3.2)
 * -------------------------------------------------------------------------- */

export class PgAgentRunStore implements AgentRunStore<Tx> {
  async start(tx: Tx, run: AgentRunRecord): Promise<string | null> {
    const inserted = await tx
      .insert(agentRuns)
      .values({
        id: run.id,
        shopId: run.shopId,
        objective: run.objective,
        status: 'RUNNING',
        conversationId: run.conversationId,
        jobCardId: run.jobCardId,
        customerId: run.customerId,
        approvalRequestId: run.approvalRequestId,
        triggerMessageId: run.triggerMessageId,
        maxSteps: run.maxSteps,
        model: run.model,
        promptContext: run.promptContext,
        startedAt: run.startedAt,
      })
      // The unique index on (shop_id, trigger_message_id) is what makes a
      // redelivered customer reply a no-op rather than a second agent talking
      // over the first.
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });

    return inserted[0]?.id ?? null;
  }

  async appendStep(tx: Tx, step: AgentStepRecord): Promise<void> {
    await tx.insert(agentSteps).values({
      shopId: step.shopId,
      runId: step.runId,
      stepIndex: step.stepIndex,
      promptHash: step.promptHash,
      model: step.model,
      responseText: step.responseText,
      toolCalls: step.toolCalls,
      toolResults: step.toolResults,
      checkerVerdicts: step.checkerVerdicts,
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      latencyMs: step.latencyMs,
    });
  }

  async finish(tx: Tx, finish: AgentRunFinish): Promise<void> {
    await tx
      .update(agentRuns)
      .set({
        status: 'FINISHED',
        outcome: finish.outcome,
        stepCount: finish.stepCount,
        inputTokens: finish.inputTokens,
        outputTokens: finish.outputTokens,
        reason: finish.reason,
        finishedAt: finish.finishedAt,
        updatedAt: finish.finishedAt,
      })
      .where(eq(agentRuns.id, finish.runId));
  }

  async abort(tx: Tx, runId: string, reason: string, at: Date): Promise<void> {
    // ABORTED, with no outcome: the run did not decide anything, and recording
    // it as `blocked` would poison the graduation report with a failure the
    // agent never caused.
    await tx
      .update(agentRuns)
      .set({ status: 'ABORTED', reason, finishedAt: at, updatedAt: at })
      .where(eq(agentRuns.id, runId));
  }

  async loadSteps(tx: Tx, shopId: string, runId: string): Promise<readonly AgentStepRecord[]> {
    const rows = await tx
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.shopId, shopId), eq(agentSteps.runId, runId)))
      .orderBy(asc(agentSteps.stepIndex));

    return rows.map((row) => ({
      runId: row.runId,
      shopId: row.shopId,
      stepIndex: row.stepIndex,
      promptHash: row.promptHash,
      model: row.model,
      responseText: row.responseText,
      toolCalls: row.toolCalls as AgentStepRecord['toolCalls'],
      toolResults: row.toolResults as AgentStepRecord['toolResults'],
      checkerVerdicts: row.checkerVerdicts as AgentStepRecord['checkerVerdicts'],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      latencyMs: row.latencyMs,
    }));
  }

  async activeRunIds(
    tx: Tx,
    shopId: string,
    conversationId: string,
  ): Promise<readonly string[]> {
    const rows = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.shopId, shopId),
          eq(agentRuns.conversationId, conversationId),
          eq(agentRuns.status, 'RUNNING'),
        ),
      );
    return rows.map((row) => row.id);
  }
}

/* -------------------------------------------------------------------------- *
 * Job-card context (3.3)
 * -------------------------------------------------------------------------- */

type CardContextRow = {
  job_card_id: string;
  code: string;
  state: string;
  customer_id: string;
  customer_name: string;
  customer_language: Language;
  registration: string;
  make: string | null;
  model: string | null;
  odometer_km: number | null;
  promised_at: Date | null;
  complaint_text: string | null;
  advisor_name: string | null;
  estimate_id: string | null;
  estimate_version: number | null;
  estimate_status: string | null;
  estimate_total: string | number | null;
};

/**
 * The read the agent sees.
 *
 * One query for the card and three small ones for its children, rather than a
 * single join that would multiply rows and need de-duplicating in TypeScript.
 * The customer's name comes back decrypted by the `encryptedText` column type,
 * which is why this goes through drizzle rather than raw SQL for that column.
 */
export class PgJobCardContextReader implements JobCardContextReader<Tx> {
  async load(tx: Tx, shopId: string, jobCardId: string): Promise<JobCardContext | null> {
    const result = await tx.execute<CardContextRow>(sql`
      select
        jc.id            as job_card_id,
        jc.code          as code,
        jc.state::text   as state,
        jc.customer_id   as customer_id,
        c.full_name_encrypted as customer_name,
        c.preferred_language::text as customer_language,
        v.registration_normalised as registration,
        v.make           as make,
        v.model          as model,
        jc.odometer_km   as odometer_km,
        jc.promised_at   as promised_at,
        jc.complaint_text as complaint_text,
        s.full_name      as advisor_name,
        e.id             as estimate_id,
        e.version        as estimate_version,
        e.status::text   as estimate_status,
        e.total_paise    as estimate_total
      from job_cards jc
      join customers c on c.id = jc.customer_id
      join vehicles  v on v.id = jc.vehicle_id
      left join staff s on s.id = jc.assigned_advisor_id
      left join lateral (
        select id, version, status, total_paise
        from estimates
        where job_card_id = jc.id and shop_id = jc.shop_id
        order by version desc
        limit 1
      ) e on true
      where jc.id = ${jobCardId} and jc.shop_id = ${shopId} and jc.deleted_at is null
    `);

    const row = result.rows[0];
    if (row === undefined) return null;

    const [items, lines, media] = await Promise.all([
      this.loadWorkItems(tx, shopId, jobCardId),
      row.estimate_id === null
        ? Promise.resolve([] as BundleLine[])
        : this.loadLines(tx, shopId, row.estimate_id),
      this.loadMedia(tx, shopId, jobCardId),
    ]);

    return {
      jobCardId: row.job_card_id,
      code: row.code,
      state: row.state,
      customerId: row.customer_id,
      customerName: decryptedOrFallback(row.customer_name),
      customerLanguage: row.customer_language,
      vehicleLabel: [row.make, row.model].filter((part) => part !== null).join(' ') || 'vehicle',
      registration: row.registration,
      odometerKm: row.odometer_km,
      promisedAt: row.promised_at,
      complaint: row.complaint_text,
      workItems: items,
      estimate:
        row.estimate_id === null
          ? null
          : {
              id: row.estimate_id,
              version: row.estimate_version ?? 1,
              status: row.estimate_status ?? 'DRAFT',
              totalPaise: Number(row.estimate_total ?? 0),
              lines,
            },
      media,
      advisorName: row.advisor_name,
    };
  }

  async findActiveJobCardId(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<string | null> {
    // The card a thread is about: the most recently touched one that is not
    // finished. A closed card is not what a customer is writing about.
    const result = await tx.execute<{ id: string }>(sql`
      select id
      from job_cards
      where shop_id = ${shopId}
        and customer_id = ${customerId}
        and deleted_at is null
        and state not in ('CLOSED', 'CANCELLED', 'DELIVERED')
      order by updated_at desc
      limit 1
    `);
    return result.rows[0]?.id ?? null;
  }

  async findByRegistration(
    tx: Tx,
    shopId: string,
    normalisedRegistration: string,
  ): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      select jc.id
      from job_cards jc
      join vehicles v on v.id = jc.vehicle_id
      where jc.shop_id = ${shopId}
        and v.registration_normalised = ${normalisedRegistration}
        and jc.deleted_at is null
        and jc.state not in ('CLOSED', 'CANCELLED')
      order by jc.updated_at desc
      limit 1
    `);
    return result.rows[0]?.id ?? null;
  }

  private async loadWorkItems(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<JobCardContext['workItems']> {
    const result = await tx.execute<{
      id: string;
      title: string;
      state: string;
      requires_approval: boolean;
      technician_note: string | null;
      estimated_minutes: number | null;
    }>(sql`
      select id, title, state::text as state, requires_approval, technician_note, estimated_minutes
      from work_items
      where shop_id = ${shopId} and job_card_id = ${jobCardId}
      order by sequence asc
    `);

    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      requiresApproval: row.requires_approval,
      technicianNote: row.technician_note,
      estimatedMinutes: row.estimated_minutes,
    }));
  }

  private async loadLines(
    tx: Tx,
    shopId: string,
    estimateId: string,
  ): Promise<BundleLine[]> {
    const result = await tx.execute<{
      id: string;
      work_item_id: string | null;
      description: string;
      kind: EstimateLineKind;
      quantity_milli: number;
      unit_price_paise: string | number;
      line_total_paise: string | number;
      tax_rate_bp: number;
    }>(sql`
      select id, work_item_id, description, kind, quantity_milli, unit_price_paise,
             line_total_paise, tax_rate_bp
      from estimate_lines
      where shop_id = ${shopId} and estimate_id = ${estimateId}
      order by sequence asc
    `);

    return result.rows.map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      description: row.description,
      kind: row.kind,
      quantityMilli: row.quantity_milli,
      unitPricePaise: Number(row.unit_price_paise),
      lineTotalPaise: Number(row.line_total_paise),
      taxRateBp: row.tax_rate_bp,
      // The quoted line total *is* the list price: it is what the shop asked
      // for before any concession, which is exactly the number a floor is a
      // percentage of.
      listPricePaise: Number(row.line_total_paise),
    }));
  }

  private async loadMedia(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<BundleMedia[]> {
    const result = await tx.execute<{
      id: string;
      kind: MediaKind;
      caption: string | null;
      work_item_id: string | null;
    }>(sql`
      select id, kind, caption, work_item_id
      from media_assets
      where shop_id = ${shopId} and job_card_id = ${jobCardId} and deleted_at is null
      order by created_at asc
    `);

    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      caption: row.caption,
      workItemId: row.work_item_id,
    }));
  }
}

/**
 * The price list, derived from what the shop actually charges.
 *
 * There is no price-list table: phase 1 stores the shop's price list as a
 * knowledge document in object storage, which is prose. What `adjust_offer`
 * needs is a *number* to compute a floor from, and the honest one is the line
 * total the shop quoted on this estimate — that is what it asked for before any
 * concession. An item with no line has no list price, and the tool refuses
 * rather than inventing one.
 */
export class PgPriceListReader implements PriceListReader<Tx> {
  async listPriceFor(tx: Tx, shopId: string, estimateLineId: string): Promise<Paise | null> {
    const result = await tx.execute<{ line_total_paise: string | number }>(sql`
      select line_total_paise
      from estimate_lines
      where id = ${estimateLineId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : Number(row.line_total_paise);
  }

  /**
   * A digest of the shop's menu for the prompt: the commonest priced items, with
   * a representative price. Never quoted to a customer — the agent quotes only
   * the estimate lines it was given — but it is what lets it recognise that a
   * request is for something the shop does at all.
   */
  async summarise(tx: Tx, shopId: string, limit: number): Promise<string> {
    const result = await tx.execute<{
      description: string;
      typical: string | number;
      seen: number;
    }>(sql`
      select
        description,
        percentile_disc(0.5) within group (order by line_total_paise) as typical,
        count(*)::int as seen
      from estimate_lines
      where shop_id = ${shopId}
      group by description
      order by seen desc, description asc
      limit ${limit}
    `);

    return result.rows
      .map((row) => `- ${row.description}: typically ${formatPaise(Number(row.typical))}`)
      .join('\n');
  }
}

/* -------------------------------------------------------------------------- *
 * Evidence bundles (3.4)
 * -------------------------------------------------------------------------- */

export class PgEvidenceBundleStore implements EvidenceBundleStore<Tx> {
  async insert(tx: Tx, bundle: EvidenceBundle): Promise<void> {
    await tx.insert(evidenceBundles).values({
      id: bundle.id,
      shopId: bundle.shopId,
      jobCardId: bundle.jobCardId,
      title: bundle.title,
      summaryText: bundle.summaryText,
      language: bundle.language,
      mediaIds: bundle.media.map((asset) => asset.id),
      estimateLineIds: bundle.lines.map((line) => line.id),
      workItemIds: [...bundle.workItemIds],
      estimateId: bundle.estimateId,
      claims: bundle.claims,
      // The notes are stored *with* the bundle, not referenced: "what did we
      // cite when we sent this" has to stay answerable after the underlying
      // note has been edited.
      sourceNotes: bundle.sourceNotes.map((note) => ({
        ...note,
        capturedAt: note.capturedAt.toISOString(),
      })),
      createdByRunId: bundle.createdByRunId,
      explanationModel: bundle.explanationModel,
      explanationPromptHash: bundle.explanationPromptHash,
      createdAt: bundle.createdAt,
    });
  }

  async load(tx: Tx, shopId: string, bundleId: string): Promise<EvidenceBundle | null> {
    const rows = await tx
      .select()
      .from(evidenceBundles)
      .where(and(eq(evidenceBundles.shopId, shopId), eq(evidenceBundles.id, bundleId)));

    const row = rows[0];
    if (row === undefined) return null;

    const lineIds = row.estimateLineIds as string[];
    const mediaIds = row.mediaIds as string[];

    const [lines, media] = await Promise.all([
      lineIds.length === 0 ? Promise.resolve([]) : this.loadLines(tx, shopId, lineIds),
      mediaIds.length === 0 ? Promise.resolve([]) : this.loadMedia(tx, shopId, mediaIds),
    ]);

    const notes = (row.sourceNotes as Array<Record<string, unknown>>).map(
      (note): SourceNote => ({
        id: String(note['id']),
        workItemId: (note['workItemId'] as string | null) ?? null,
        authorStaffId: (note['authorStaffId'] as string | null) ?? null,
        text: String(note['text']),
        language: (note['language'] as Language) ?? row.language,
        capturedAt: new Date(String(note['capturedAt'])),
      }),
    );

    return {
      id: row.id,
      shopId: row.shopId,
      jobCardId: row.jobCardId,
      title: row.title,
      summaryText: row.summaryText,
      language: row.language,
      media,
      lines,
      workItemIds: row.workItemIds as string[],
      estimateId: row.estimateId,
      claims: row.claims as Claim[],
      sourceNotes: notes,
      totalPaise: lines.reduce((sum, line) => sum + line.lineTotalPaise, 0),
      createdByRunId: row.createdByRunId,
      explanationModel: row.explanationModel,
      explanationPromptHash: row.explanationPromptHash,
      createdAt: row.createdAt,
    };
  }

  async findLatestForJobCard(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<EvidenceBundle | null> {
    const rows = await tx
      .select({ id: evidenceBundles.id })
      .from(evidenceBundles)
      .where(
        and(eq(evidenceBundles.shopId, shopId), eq(evidenceBundles.jobCardId, jobCardId)),
      )
      .orderBy(desc(evidenceBundles.createdAt))
      .limit(1);

    const id = rows[0]?.id;
    return id === undefined ? null : this.load(tx, shopId, id);
  }

  /**
   * Technician notes captured against a card, newest last.
   *
   * Read out of the bundles already built for it: a note that has not been
   * turned into a bundle is not yet evidence anyone reviewed, and the builder
   * deliberately does not let the agent cite one.
   */
  async loadSourceNotes(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<readonly SourceNote[]> {
    const rows = await tx
      .select({ sourceNotes: evidenceBundles.sourceNotes, language: evidenceBundles.language })
      .from(evidenceBundles)
      .where(and(eq(evidenceBundles.shopId, shopId), eq(evidenceBundles.jobCardId, jobCardId)))
      .orderBy(asc(evidenceBundles.createdAt));

    return rows.flatMap((row) =>
      (row.sourceNotes as Array<Record<string, unknown>>).map(
        (note): SourceNote => ({
          id: String(note['id']),
          workItemId: (note['workItemId'] as string | null) ?? null,
          authorStaffId: (note['authorStaffId'] as string | null) ?? null,
          text: String(note['text']),
          language: (note['language'] as Language) ?? row.language,
          capturedAt: new Date(String(note['capturedAt'])),
        }),
      ),
    );
  }

  private async loadLines(tx: Tx, shopId: string, ids: string[]): Promise<BundleLine[]> {
    const result = await tx.execute<{
      id: string;
      work_item_id: string | null;
      description: string;
      kind: EstimateLineKind;
      quantity_milli: number;
      unit_price_paise: string | number;
      line_total_paise: string | number;
      tax_rate_bp: number;
    }>(sql`
      select id, work_item_id, description, kind, quantity_milli, unit_price_paise,
             line_total_paise, tax_rate_bp
      from estimate_lines
      where shop_id = ${shopId} and id = any(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})
      order by sequence asc
    `);

    return result.rows.map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      description: row.description,
      kind: row.kind,
      quantityMilli: row.quantity_milli,
      unitPricePaise: Number(row.unit_price_paise),
      lineTotalPaise: Number(row.line_total_paise),
      taxRateBp: row.tax_rate_bp,
      listPricePaise: Number(row.line_total_paise),
    }));
  }

  private async loadMedia(tx: Tx, shopId: string, ids: string[]): Promise<BundleMedia[]> {
    const result = await tx.execute<{
      id: string;
      kind: MediaKind;
      caption: string | null;
      work_item_id: string | null;
    }>(sql`
      select id, kind, caption, work_item_id
      from media_assets
      where shop_id = ${shopId} and id = any(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})
      order by created_at asc
    `);

    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      caption: row.caption,
      workItemId: row.work_item_id,
    }));
  }
}

/* -------------------------------------------------------------------------- *
 * Approvals (3.6)
 * -------------------------------------------------------------------------- */

export class PgApprovalStore implements ApprovalStore<Tx> {
  async insert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly customerId: string;
      readonly conversationId: string;
      readonly evidenceBundleId: string | null;
      readonly estimateId: string | null;
      readonly ladderRef: string;
      readonly workItemIds: readonly string[];
      readonly amountPaise: Paise;
      readonly agentRunId: string | null;
      readonly deadlineAt: Date | null;
      readonly requestedAt: Date;
    },
  ): Promise<void> {
    await tx.insert(approvalRequests).values({
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      evidenceBundleId: input.evidenceBundleId,
      estimateId: input.estimateId,
      ladderRef: input.ladderRef,
      objective: input.ladderRef,
      workItemIds: [...input.workItemIds],
      amountPaise: input.amountPaise,
      agentRunId: input.agentRunId,
      deadlineAt: input.deadlineAt,
      requestedAt: input.requestedAt,
      status: 'PENDING',
    });
  }

  async lockById(
    tx: Tx,
    shopId: string,
    approvalId: string,
  ): Promise<ApprovalSnapshot | null> {
    // `FOR UPDATE`, because two taps of Approve arrive as two webhooks and only
    // one of them may become a decision.
    const result = await tx.execute<ApprovalRow>(sql`
      select
        id, shop_id, job_card_id, customer_id, conversation_id, evidence_bundle_id,
        estimate_id, status::text as status, decision::text as decision, ladder_ref,
        work_item_ids, approved_work_item_ids, amount_paise, approved_amount_paise,
        request_message_id, agent_run_id, requested_at, deadline_at, decided_at
      from approval_requests
      where id = ${approvalId} and shop_id = ${shopId}
      for update
    `);

    const row = result.rows[0];
    return row === undefined ? null : toApprovalSnapshot(row);
  }

  async findOpenByConversation(
    tx: Tx,
    shopId: string,
    conversationId: string,
  ): Promise<ApprovalSnapshot | null> {
    const result = await tx.execute<ApprovalRow>(sql`
      select
        id, shop_id, job_card_id, customer_id, conversation_id, evidence_bundle_id,
        estimate_id, status::text as status, decision::text as decision, ladder_ref,
        work_item_ids, approved_work_item_ids, amount_paise, approved_amount_paise,
        request_message_id, agent_run_id, requested_at, deadline_at, decided_at
      from approval_requests
      where shop_id = ${shopId}
        and conversation_id = ${conversationId}
        and decided_at is null
      order by requested_at desc
      limit 1
    `);

    const row = result.rows[0];
    return row === undefined ? null : toApprovalSnapshot(row);
  }

  async attachRequestMessage(tx: Tx, approvalId: string, messageId: string): Promise<void> {
    await tx
      .update(approvalRequests)
      .set({ requestMessageId: messageId })
      .where(eq(approvalRequests.id, approvalId));
  }

  async recordDecision(
    tx: Tx,
    input: {
      readonly approvalId: string;
      readonly status: ApprovalStatus;
      readonly decision: CustomerDecision;
      readonly approvedWorkItemIds: readonly string[];
      readonly approvedAmountPaise: Paise;
      readonly decisionChannel: string;
      readonly decisionNote: string;
      readonly decidedAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(approvalRequests)
      .set({
        status: input.status,
        decision: input.decision,
        approvedWorkItemIds: [...input.approvedWorkItemIds],
        approvedAmountPaise: input.approvedAmountPaise,
        decisionChannel: input.decisionChannel,
        decisionNote: input.decisionNote,
        decidedAt: input.decidedAt,
        updatedAt: input.decidedAt,
      })
      .where(eq(approvalRequests.id, input.approvalId));
  }
}

type ApprovalRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  customer_id: string | null;
  conversation_id: string | null;
  evidence_bundle_id: string | null;
  estimate_id: string | null;
  status: ApprovalStatus;
  decision: CustomerDecision | null;
  ladder_ref: string;
  work_item_ids: unknown;
  approved_work_item_ids: unknown;
  amount_paise: string | number;
  approved_amount_paise: string | number;
  request_message_id: string | null;
  agent_run_id: string | null;
  requested_at: Date | string;
  deadline_at: Date | string | null;
  decided_at: Date | string | null;
};

function toApprovalSnapshot(row: ApprovalRow): ApprovalSnapshot {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    evidenceBundleId: row.evidence_bundle_id,
    estimateId: row.estimate_id,
    status: row.status,
    decision: row.decision,
    ladderRef: row.ladder_ref,
    workItemIds: asStringArray(row.work_item_ids),
    approvedWorkItemIds: asStringArray(row.approved_work_item_ids),
    amountPaise: Number(row.amount_paise),
    approvedAmountPaise: Number(row.approved_amount_paise),
    requestMessageId: row.request_message_id,
    agentRunId: row.agent_run_id,
    requestedAt: asDate(row.requested_at),
    deadlineAt: row.deadline_at === null ? null : asDate(row.deadline_at),
    decidedAt: row.decided_at === null ? null : asDate(row.decided_at),
  };
}

/* -------------------------------------------------------------------------- *
 * Escalations (3.7)
 * -------------------------------------------------------------------------- */

export class PgEscalationStore implements EscalationStore<Tx> {
  async schedule(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly objective: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly ladderKey: string;
      readonly rung: number;
      readonly rungType: EscalationRungType;
      readonly channel: 'WHATSAPP' | 'SMS' | 'VOICE' | 'HUMAN';
      readonly label: string;
      readonly scheduledAt: Date;
      readonly queueJobId: string | null;
    },
  ): Promise<string | null> {
    const inserted = await tx
      .insert(escalations)
      .values({
        id: input.id,
        shopId: input.shopId,
        objective: input.objective as 'APPROVAL',
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ladderKey: input.ladderKey,
        rung: input.rung,
        rungType: input.rungType,
        channel: input.channel,
        label: input.label,
        status: 'SCHEDULED',
        scheduledAt: input.scheduledAt,
        queueJobId: input.queueJobId,
      })
      // The unique index on (subject_type, subject_id, rung) is the idempotency:
      // a redelivered `approval.requested` schedules nothing. A quiet-hours
      // deferral re-schedules the *same* row, which is an update rather than a
      // duplicate, so it targets the id explicitly.
      .onConflictDoUpdate({
        target: [escalations.subjectType, escalations.subjectId, escalations.rung],
        set: {
          scheduledAt: sql`case when ${escalations.id} = ${input.id} then excluded.scheduled_at else ${escalations.scheduledAt} end`,
          queueJobId: sql`case when ${escalations.id} = ${input.id} then excluded.queue_job_id else ${escalations.queueJobId} end`,
          status: sql`case when ${escalations.id} = ${input.id} then 'SCHEDULED'::escalation_status else ${escalations.status} end`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: escalations.id });

    const id = inserted[0]?.id;
    // The conflict path returns the *existing* row's id; only a genuinely new
    // row (or the same row being re-scheduled) counts as scheduled.
    return id === input.id ? id : null;
  }

  async attachQueueJob(tx: Tx, escalationId: string, queueJobId: string): Promise<void> {
    await tx
      .update(escalations)
      .set({ queueJobId, updatedAt: sql`now()` })
      .where(eq(escalations.id, escalationId));
  }

  async claim(tx: Tx, shopId: string, escalationId: string): Promise<ScheduledRung | null> {
    const result = await tx.execute<EscalationRowShape>(sql`
      select
        id, shop_id, objective::text as objective, subject_type, subject_id,
        ladder_key, rung, rung_type::text as rung_type, label, scheduled_at, queue_job_id
      from escalations
      where id = ${escalationId} and shop_id = ${shopId} and status = 'SCHEDULED'
      for update
    `);

    const row = result.rows[0];
    return row === undefined ? null : toScheduledRung(row);
  }

  async markExecuted(
    tx: Tx,
    input: {
      readonly escalationId: string;
      readonly outcome: string;
      readonly detail: string;
      readonly at: Date;
    },
  ): Promise<void> {
    // A deferral has not run: the rung stays SCHEDULED with its new time, and
    // only its result detail is recorded.
    if (input.outcome === 'DEFERRED') {
      await tx
        .update(escalations)
        .set({ resultDetail: input.detail, updatedAt: input.at })
        .where(eq(escalations.id, input.escalationId));
      return;
    }

    await tx
      .update(escalations)
      .set({
        status: 'EXECUTED',
        executedAt: input.at,
        resultDetail: `${input.outcome}: ${input.detail}`,
        updatedAt: input.at,
      })
      .where(eq(escalations.id, input.escalationId));
  }

  async markSkipped(tx: Tx, escalationId: string, reason: string, at: Date): Promise<void> {
    await tx
      .update(escalations)
      .set({ status: 'SKIPPED', executedAt: at, skipReason: reason, updatedAt: at })
      .where(eq(escalations.id, escalationId));
  }

  async cancelForSubject(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly at: Date;
    },
  ): Promise<readonly ScheduledRung[]> {
    // Cancelled and returned in one statement: the caller needs the queue job
    // ids to drop the timers, and reading them first would race a rung that
    // fires in between.
    const result = await tx.execute<EscalationRowShape>(sql`
      update escalations
      set status = 'CANCELLED', cancelled_at = ${input.at}, updated_at = ${input.at}
      where shop_id = ${input.shopId}
        and subject_type = ${input.subjectType}
        and subject_id = ${input.subjectId}
        and status = 'SCHEDULED'
      returning
        id, shop_id, objective::text as objective, subject_type, subject_id,
        ladder_key, rung, rung_type::text as rung_type, label, scheduled_at, queue_job_id
    `);

    return result.rows.map(toScheduledRung).sort((a, b) => a.rung - b.rung);
  }

  async pendingForSubject(
    tx: Tx,
    shopId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<readonly ScheduledRung[]> {
    const result = await tx.execute<EscalationRowShape>(sql`
      select
        id, shop_id, objective::text as objective, subject_type, subject_id,
        ladder_key, rung, rung_type::text as rung_type, label, scheduled_at, queue_job_id
      from escalations
      where shop_id = ${shopId}
        and subject_type = ${subjectType}
        and subject_id = ${subjectId}
        and status = 'SCHEDULED'
      order by rung asc
    `);

    return result.rows.map(toScheduledRung);
  }
}

type EscalationRowShape = {
  id: string;
  shop_id: string;
  objective: string;
  subject_type: string;
  subject_id: string;
  ladder_key: string;
  rung: number;
  rung_type: EscalationRungType;
  label: string | null;
  scheduled_at: Date | string;
  queue_job_id: string | null;
};

function toScheduledRung(row: EscalationRowShape): ScheduledRung {
  return {
    id: row.id,
    shopId: row.shop_id,
    objective: row.objective,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    ladderKey: row.ladder_key,
    rung: row.rung,
    rungType: row.rung_type,
    label: row.label ?? '',
    scheduledAt: asDate(row.scheduled_at),
    queueJobId: row.queue_job_id,
  };
}

/* -------------------------------------------------------------------------- *
 * Advisor tasks (L6)
 * -------------------------------------------------------------------------- */

export class PgAdvisorTaskStore implements AdvisorTaskStore<Tx> {
  async create(tx: Tx, id: string, input: AdvisorTaskInput, at: Date): Promise<string> {
    const inserted = await tx
      .insert(advisorTasks)
      .values({
        id,
        shopId: input.shopId,
        kind: input.kind,
        status: 'OPEN',
        urgency: input.urgency,
        brief: input.brief,
        context: input.context,
        jobCardId: input.jobCardId ?? null,
        conversationId: input.conversationId ?? null,
        customerId: input.customerId ?? null,
        approvalRequestId: input.approvalRequestId ?? null,
        agentRunId: input.agentRunId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        dueAt: input.dueAt ?? null,
        createdAt: at,
      })
      // A redelivered ladder rung re-uses the task it already raised rather than
      // filling an advisor's list with copies of the same phone call.
      .onConflictDoNothing({ target: [advisorTasks.shopId, advisorTasks.dedupeKey] })
      .returning({ id: advisorTasks.id });

    const created = inserted[0]?.id;
    if (created !== undefined) return created;

    const existing = await tx
      .select({ id: advisorTasks.id })
      .from(advisorTasks)
      .where(
        and(
          eq(advisorTasks.shopId, input.shopId),
          eq(advisorTasks.dedupeKey, input.dedupeKey ?? ''),
        ),
      );
    return existing[0]?.id ?? id;
  }

  async list(
    tx: Tx,
    shopId: string,
    status: AdvisorTaskStatus,
    limit: number,
  ): Promise<readonly AdvisorTaskSnapshot[]> {
    // HIGH first, then oldest: an advisor working top-down does the most urgent
    // thing that has waited longest.
    const result = await tx.execute<AdvisorTaskRowShape>(sql`
      select
        id, shop_id, kind::text as kind, status::text as status, urgency::text as urgency,
        brief, context, job_card_id, conversation_id, customer_id, approval_request_id,
        agent_run_id, due_at, created_at
      from advisor_tasks
      where shop_id = ${shopId} and status = ${status}::advisor_task_status
      order by
        case urgency when 'HIGH' then 0 when 'NORMAL' then 1 else 2 end,
        created_at asc
      limit ${limit}
    `);

    return result.rows.map((row) => ({
      id: row.id,
      shopId: row.shop_id,
      kind: row.kind as AdvisorTaskSnapshot['kind'],
      status: row.status as AdvisorTaskStatus,
      urgency: row.urgency as AdvisorTaskSnapshot['urgency'],
      brief: row.brief,
      context: row.context as Readonly<Record<string, unknown>>,
      jobCardId: row.job_card_id,
      conversationId: row.conversation_id,
      customerId: row.customer_id,
      approvalRequestId: row.approval_request_id,
      agentRunId: row.agent_run_id,
      dueAt: row.due_at === null ? null : asDate(row.due_at),
      createdAt: asDate(row.created_at),
    }));
  }

  async resolve(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly taskId: string;
      readonly status: AdvisorTaskStatus;
      readonly staffId: string | null;
      readonly note: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx
      .update(advisorTasks)
      .set({
        status: input.status,
        resolvedAt: input.at,
        resolvedByStaffId: input.staffId,
        resolutionNote: input.note,
        updatedAt: input.at,
      })
      .where(and(eq(advisorTasks.shopId, input.shopId), eq(advisorTasks.id, input.taskId)));
  }

  async cancelForApproval(
    tx: Tx,
    shopId: string,
    approvalId: string,
    at: Date,
  ): Promise<number> {
    const result = await tx
      .update(advisorTasks)
      .set({ status: 'CANCELLED', resolvedAt: at, updatedAt: at })
      .where(
        and(
          eq(advisorTasks.shopId, shopId),
          eq(advisorTasks.approvalRequestId, approvalId),
          eq(advisorTasks.status, 'OPEN'),
        ),
      );
    return result.rowCount ?? 0;
  }
}

type AdvisorTaskRowShape = {
  id: string;
  shop_id: string;
  kind: string;
  status: string;
  urgency: string;
  brief: string;
  context: unknown;
  job_card_id: string | null;
  conversation_id: string | null;
  customer_id: string | null;
  approval_request_id: string | null;
  agent_run_id: string | null;
  due_at: Date | string | null;
  created_at: Date | string;
};

/* -------------------------------------------------------------------------- *
 * HITL review queue (3.9)
 * -------------------------------------------------------------------------- */

export class PgReviewStore implements ReviewStore<Tx> {
  async pending(tx: Tx, shopId: string, limit: number): Promise<readonly PendingCandidate[]> {
    const result = await tx.execute<CandidateRowShape>(sql`
      select
        m.id as message_id, m.shop_id, m.conversation_id, m.job_card_id, m.agent_run_id,
        m.body, m.language::text as language, m.evidence_refs, m.created_at,
        coalesce(conv.display_name, 'Customer') as customer_label,
        coalesce(step.checker_reasons, '[]'::jsonb) as checker_reasons
      from messages m
      join conversations conv on conv.id = m.conversation_id
      left join lateral (
        select jsonb_agg(v->>'reason') as checker_reasons
        from agent_steps s, jsonb_array_elements(s.checker_verdicts) v
        where s.run_id = m.agent_run_id and (v->>'ok')::boolean is false
      ) step on true
      where m.shop_id = ${shopId}
        and m.direction = 'OUTBOUND'
        and m.status = 'PENDING_APPROVAL'
      order by m.created_at asc
      limit ${limit}
    `);

    return result.rows.map(toCandidate);
  }

  async loadCandidate(
    tx: Tx,
    shopId: string,
    messageId: string,
  ): Promise<PendingCandidate | null> {
    const result = await tx.execute<CandidateRowShape>(sql`
      select
        m.id as message_id, m.shop_id, m.conversation_id, m.job_card_id, m.agent_run_id,
        m.body, m.language::text as language, m.evidence_refs, m.created_at,
        coalesce(conv.display_name, 'Customer') as customer_label,
        coalesce(step.checker_reasons, '[]'::jsonb) as checker_reasons
      from messages m
      join conversations conv on conv.id = m.conversation_id
      left join lateral (
        select jsonb_agg(v->>'reason') as checker_reasons
        from agent_steps s, jsonb_array_elements(s.checker_verdicts) v
        where s.run_id = m.agent_run_id and (v->>'ok')::boolean is false
      ) step on true
      where m.shop_id = ${shopId}
        and m.id = ${messageId}
        and m.status = 'PENDING_APPROVAL'
    `);

    const row = result.rows[0];
    return row === undefined ? null : toCandidate(row);
  }

  async recordReview(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly messageId: string;
      readonly conversationId: string;
      readonly agentRunId: string | null;
      readonly action: ReviewAction;
      readonly reviewerStaffId: string | null;
      readonly bodyBefore: string;
      readonly bodyAfter: string | null;
      readonly diff: readonly unknown[];
      readonly rejectionReason: string | null;
      readonly checkerReasons: readonly string[];
      readonly waitedMs: number;
      readonly at: Date;
    },
  ): Promise<void> {
    // One review per message, by unique index: an advisor cannot approve and
    // then reject the same candidate, and the graduation report cannot be
    // double-counted.
    await tx.insert(messageReviews).values({
      id: input.id,
      shopId: input.shopId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      agentRunId: input.agentRunId,
      action: input.action,
      reviewerStaffId: input.reviewerStaffId,
      bodyBefore: input.bodyBefore,
      bodyAfter: input.bodyAfter,
      diff: input.diff,
      rejectionReason: input.rejectionReason,
      checkerReasons: [...input.checkerReasons],
      waitedMs: input.waitedMs,
      createdAt: input.at,
    });
  }

  async updateBody(tx: Tx, shopId: string, messageId: string, body: string): Promise<void> {
    await tx.execute(sql`
      update messages set body = ${body}, updated_at = now()
      where id = ${messageId} and shop_id = ${shopId}
    `);
  }

  async markRejected(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly messageId: string;
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update messages
      set status = 'BLOCKED',
          blocked_code = 'REJECTED_BY_ADVISOR',
          blocked_reason = ${input.reason},
          updated_at = ${input.at}
      where id = ${input.messageId} and shop_id = ${input.shopId}
    `);
  }

  async graduationCounts(
    tx: Tx,
    input: { readonly shopId: string; readonly objective: AgentObjective; readonly limit: number },
  ): Promise<{
    readonly approvedWithoutEdit: number;
    readonly approvedWithEdit: number;
    readonly rejected: number;
    readonly checkerBlocks: number;
    readonly runs: number;
    readonly waitTimesMs: readonly number[];
  }> {
    // Reviews are scoped to the objective by joining through `agent_run_id`,
    // which is the fix open question 14 named: a shop running two flows must not
    // graduate one on the other's record.
    const reviews = await tx.execute<{ action: ReviewAction; waited_ms: number }>(sql`
      select r.action::text as action, r.waited_ms
      from message_reviews r
      join agent_runs run on run.id = r.agent_run_id
      where r.shop_id = ${input.shopId}
        and run.objective = ${input.objective}::agent_objective
      order by r.created_at desc
      limit ${input.limit}
    `);

    const runs = await tx.execute<{ total: number; blocked: number }>(sql`
      select
        count(*)::int as total,
        count(*) filter (where outcome = 'blocked')::int as blocked
      from (
        select outcome
        from agent_runs
        where shop_id = ${input.shopId}
          and objective = ${input.objective}::agent_objective
          and status = 'FINISHED'
        order by started_at desc
        limit ${input.limit}
      ) recent
    `);

    const rows = reviews.rows;
    return {
      approvedWithoutEdit: rows.filter((row) => row.action === 'APPROVE_SEND').length,
      approvedWithEdit: rows.filter((row) => row.action === 'EDIT_AND_SEND').length,
      rejected: rows.filter((row) => row.action === 'REJECT').length,
      checkerBlocks: Number(runs.rows[0]?.blocked ?? 0),
      runs: Number(runs.rows[0]?.total ?? 0),
      waitTimesMs: rows.map((row) => Number(row.waited_ms)),
    };
  }
}

type CandidateRowShape = {
  message_id: string;
  shop_id: string;
  conversation_id: string;
  job_card_id: string | null;
  agent_run_id: string | null;
  body: string;
  language: Language;
  evidence_refs: unknown;
  created_at: Date | string;
  customer_label: string;
  checker_reasons: unknown;
};

function toCandidate(row: CandidateRowShape): PendingCandidate {
  return {
    messageId: row.message_id,
    shopId: row.shop_id,
    conversationId: row.conversation_id,
    customerLabel: row.customer_label,
    jobCardId: row.job_card_id,
    agentRunId: row.agent_run_id,
    body: row.body,
    language: row.language,
    checkerReasons: asStringArray(row.checker_reasons),
    evidenceRefs: asStringArray(row.evidence_refs),
    createdAt: asDate(row.created_at),
  };
}

/* -------------------------------------------------------------------------- *
 * Shared coercions
 *
 * `tx.execute` returns raw driver rows, so timestamps arrive as strings and
 * jsonb as `unknown`. Converting at this boundary — rather than letting a
 * string masquerade as a Date up the stack — is the lesson phase 2 learned the
 * hard way (deviation 17b).
 * -------------------------------------------------------------------------- */

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The decrypted customer name, or a neutral fallback.
 *
 * `encryptedText` decrypts through drizzle's own select path; this query is raw
 * SQL, so the ciphertext arrives as-is and is decrypted here explicitly. A row
 * that cannot be read (a rotated key, a partially restored backup) must not stop
 * an approval reaching a customer, and it must certainly not put ciphertext in a
 * message — "the customer" is the honest degradation.
 */
function decryptedOrFallback(ciphertext: string): string {
  try {
    const value = decryptPii(ciphertext).trim();
    return value.length === 0 ? 'the customer' : value;
  } catch {
    return 'the customer';
  }
}

/** Every phase-3 store, built once. */
export interface AgentStores {
  readonly runs: PgAgentRunStore;
  readonly cards: PgJobCardContextReader;
  readonly prices: PgPriceListReader;
  readonly bundles: PgEvidenceBundleStore;
  readonly approvals: PgApprovalStore;
  readonly escalations: PgEscalationStore;
  readonly tasks: PgAdvisorTaskStore;
  readonly reviews: PgReviewStore;
}

export function createAgentStores(): AgentStores {
  return {
    runs: new PgAgentRunStore(),
    cards: new PgJobCardContextReader(),
    prices: new PgPriceListReader(),
    bundles: new PgEvidenceBundleStore(),
    approvals: new PgApprovalStore(),
    escalations: new PgEscalationStore(),
    tasks: new PgAdvisorTaskStore(),
    reviews: new PgReviewStore(),
  };
}
