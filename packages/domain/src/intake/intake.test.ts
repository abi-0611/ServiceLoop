import { defaultShopConfig } from '@serviceloop/config';
import {
  applyCorrection,
  draftFields,
  emptyJobCardDraft,
  JobCardDraftSchema,
  lowConfidenceFields,
  normaliseRegistration,
  overallConfidence,
  type JobCardDraft,
} from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDraftSummary,
  DRAFT_ACTION_IDS,
  parseDraftAction,
  parseQuickCorrection,
  pathForLine,
} from './confirmation';
import { EntityResolutionError, EntityResolutionService } from './entity-resolution';
import { IntakeService } from './intake-service';
import type { Actor } from '../job-card/context';
import { JobCardTransitionService } from '../job-card/transition-service';
import { createDomainTestHarness, type DomainTestHarness, type MemoryTx } from '../testing/in-memory';
import {
  createIntakeWorld,
  InMemoryDraftStore,
  InMemoryEntityLookup,
  InMemoryJobCardWriter,
  type IntakeWorld,
} from '../testing/in-memory-intake';

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const ADVISOR: Actor = { type: 'STAFF', id: '01920000-0000-7000-8000-000000000102' };
const TRACE = 'trace-intake';
const NOW = new Date('2026-08-14T08:30:00.000Z');

interface Harness {
  readonly harness: DomainTestHarness;
  readonly intake: IntakeWorld;
  readonly entities: EntityResolutionService<MemoryTx>;
  readonly service: IntakeService<MemoryTx>;
  readonly lookup: InMemoryEntityLookup;
}

function build(): Harness {
  const now = (): Date => new Date(NOW);
  const harness = createDomainTestHarness(now);
  const clock = { now };
  const intake = createIntakeWorld();

  harness.world.addShop(SHOP, 'Asia/Kolkata');
  harness.world.configs.set(SHOP, defaultShopConfig('Asia/Kolkata'));

  const lookup = new InMemoryEntityLookup(intake, harness.world);
  const entities = new EntityResolutionService<MemoryTx>({
    uow: harness.uow,
    lookup,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const cards = new JobCardTransitionService<MemoryTx>({
    uow: harness.uow,
    cards: harness.cards,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const service = new IntakeService<MemoryTx>({
    uow: harness.uow,
    drafts: new InMemoryDraftStore(intake),
    writer: new InMemoryJobCardWriter(intake, harness.world),
    entities,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    cards,
    clock,
  });

  return { harness, intake, entities, service, lookup };
}

function draftOf(overrides: Partial<JobCardDraft> = {}): JobCardDraft {
  const sure = <T>(value: T) => ({ value, confidence: 0.97, region: null });
  return JobCardDraftSchema.parse({
    customer: { name: sure('Anand Krishnan'), phone: sure('98411 00001') },
    vehicle: {
      registration: sure('TN 09 BX 1234'),
      make: sure('Maruti Suzuki'),
      model: sure('Swift VDi'),
      odometerKm: sure(78450),
    },
    complaints: [sure('Front brake noise'), sure('Steering vibration above 60 kmph')],
    estimateLines: [
      {
        description: sure('Front brake pad set'),
        quantityMilli: sure(1000),
        unitPricePaise: sure(245000),
      },
    ],
    advisorName: sure('Priya'),
    promisedAt: sure(null),
    language: 'ta',
    notes: '',
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- *
 * Registration normalisation — the variant table
 * -------------------------------------------------------------------------- */

describe('Indian registration normalisation', () => {
  it.each([
    // [input, expected normalised, note]
    ['TN09BX1234', 'TN09BX1234', 'already canonical'],
    ['TN 09 BX 1234', 'TN09BX1234', 'spaced'],
    ['tn-09-bx-1234', 'TN09BX1234', 'lowercase and hyphenated'],
    ['TN.09.BX.1234', 'TN09BX1234', 'dot separated'],
    ['  TN09BX1234  ', 'TN09BX1234', 'padded'],
    ['TN9BX1234', 'TN09BX1234', 'single-digit RTO padded'],
    ['TN09BX234', 'TN09BX0234', 'three-digit series padded'],
    ['TN09BX34', 'TN09BX0034', 'two-digit series padded'],
    ['TN09B1234', 'TN09B1234', 'single-letter series'],
    ['TN091234', 'TN091234', 'no series letters'],
    ['MH12AB0001', 'MH12AB0001', 'Maharashtra'],
    ['KA05MN9999', 'KA05MN9999', 'Karnataka'],
    ['DL8CAF5030', 'DL08CAF5030', 'Delhi three-letter series'],
    ['UP32AB1234', 'UP32AB1234', 'Uttar Pradesh'],
    ['KL07CD4567', 'KL07CD4567', 'Kerala'],
    ['AP09XY7788', 'AP09XY7788', 'legacy Andhra code'],
    ['TS08AB1122', 'TS08AB1122', 'Telangana'],
    ['OD02AA1111', 'OD02AA1111', 'Odisha current code'],
    ['OR02AA1111', 'OR02AA1111', 'Odisha historic code still on plates'],
    ['UA07AB1234', 'UA07AB1234', 'Uttarakhand historic code'],
    ['24BH4477A', '24BH4477A', 'BH series'],
    ['24 BH 4477 A', '24BH4477A', 'BH series spaced'],
    ['24bh4477aa', '24BH4477AA', 'BH series two-letter suffix'],
    ['TN O9 BX 1234', 'TN09BX1234', 'OCR read 0 as O in the RTO code'],
    ['TNQ9BX1234', 'TN09BX1234', 'OCR read 0 as Q in the RTO code'],
  ])('normalises %s → %s (%s)', (input, expected) => {
    const result = normaliseRegistration(input);
    expect(result.ok, `${input} should normalise`).toBe(true);
    if (result.ok) expect(result.value.normalised).toBe(expected);
  });

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['XX09BX1234', 'UNKNOWN_STATE_CODE'],
    // `1` repairs to `I`, and `IN` is not an RTO code. There is no way to know
    // the writer meant `TN`, so this is refused rather than invented — a
    // fabricated plate is a vehicle nobody can ever match again.
    ['1N09BX1234', 'UNKNOWN_STATE_CODE'],
    ['TN09BX12345', 'UNRECOGNISED_FORMAT'],
    ['NOTAPLATE', 'UNRECOGNISED_FORMAT'],
  ])('refuses %s with %s', (input, kind) => {
    const result = normaliseRegistration(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  it('keeps two genuinely different plates distinct after normalisation', () => {
    const left = normaliseRegistration('TN09BX1234');
    const right = normaliseRegistration('TN09BX1284');
    expect(left.ok && right.ok).toBe(true);
    if (left.ok && right.ok) {
      expect(left.value.normalised).not.toBe(right.value.normalised);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Entity resolution
 * -------------------------------------------------------------------------- */

describe('entity resolution', () => {
  let world: Harness;

  beforeEach(() => {
    world = build();
  });

  const resolveInput = (overrides: Record<string, unknown> = {}) => ({
    shopId: SHOP,
    customer: { fullName: 'Anand Krishnan', phone: '98411 00001' },
    vehicle: { registration: 'TN 09 BX 1234', make: 'Maruti Suzuki', model: 'Swift' },
    actor: ADVISOR,
    traceId: TRACE,
    defaultLanguage: 'en' as const,
    ...overrides,
  });

  it('creates a customer and vehicle on a first visit', async () => {
    const resolution = await world.entities.resolve(resolveInput());

    expect(resolution.customerCreated).toBe(true);
    expect(resolution.vehicleCreated).toBe(true);
    expect(resolution.registrationNormalised).toBe('TN09BX1234');
    expect(resolution.phoneE164).toBe('+919841100001');
    expect(resolution.suggestions).toEqual([]);
  });

  it('reuses both records on a return visit, however the plate was written', async () => {
    const first = await world.entities.resolve(resolveInput());
    const second = await world.entities.resolve(
      resolveInput({ vehicle: { registration: 'tn-09-bx-1234' } }),
    );

    expect(second.customerId).toBe(first.customerId);
    expect(second.vehicleId).toBe(first.vehicleId);
    expect(second.customerCreated).toBe(false);
    expect(second.vehicleCreated).toBe(false);
    expect(world.intake.vehicles.size).toBe(1);
  });

  it('matches a returning customer by phone however it was typed', async () => {
    const first = await world.entities.resolve(resolveInput());
    const second = await world.entities.resolve(
      resolveInput({
        customer: { fullName: 'A. Krishnan', phone: '+91 98411 00001' },
        vehicle: { registration: 'TN 10 AM 8890' },
      }),
    );

    expect(second.customerId).toBe(first.customerId);
    expect(second.customerCreated).toBe(false);
    expect(second.vehicleCreated).toBe(true);
  });

  it('queues a merge suggestion instead of moving a vehicle to a new owner', async () => {
    const first = await world.entities.resolve(resolveInput());

    // Same car, different phone — a sale, a family member, or a typo. All three
    // are a person's decision.
    const second = await world.entities.resolve(
      resolveInput({ customer: { fullName: 'Ravi Kumar', phone: '98411 00002' } }),
    );

    expect(second.vehicleId).toBe(first.vehicleId);
    // The visit still attaches to the record the car already has.
    expect(second.customerId).toBe(first.customerId);
    expect(second.suggestions).toHaveLength(1);
    expect(second.suggestions[0]?.kind).toBe('CUSTOMER');

    const events = world.harness.world.eventsOfType('merge_suggestion.created');
    expect(events).toHaveLength(1);
    expect(world.harness.world.auditActions()).toContain('merge_suggestion.created');
  });

  it('never silently merges: the second customer record still exists', async () => {
    await world.entities.resolve(resolveInput());
    await world.entities.resolve(
      resolveInput({ customer: { fullName: 'Ravi Kumar', phone: '98411 00002' } }),
    );

    // Two customers, one vehicle, one open question for an advisor.
    expect(world.intake.customerRows.size).toBe(2);
    expect(world.intake.suggestions.filter((row) => row.status === 'OPEN')).toHaveLength(1);
  });

  it('does not pile up duplicate suggestions for the same pair', async () => {
    await world.entities.resolve(resolveInput());
    await world.entities.resolve(
      resolveInput({ customer: { fullName: 'Ravi Kumar', phone: '98411 00002' } }),
    );
    const third = await world.entities.resolve(
      resolveInput({ customer: { fullName: 'Ravi Kumar', phone: '98411 00002' } }),
    );

    expect(third.suggestions).toHaveLength(0);
    expect(world.intake.suggestions).toHaveLength(1);
  });

  it('flags a near-miss registration as a possible misread', async () => {
    await world.entities.resolve(resolveInput());

    // One digit apart from the plate already on file: classic OCR confusion.
    const second = await world.entities.resolve(
      resolveInput({
        customer: { fullName: 'Meena S', phone: '98411 00003' },
        vehicle: { registration: 'TN 09 BX 1284' },
      }),
    );

    expect(second.vehicleCreated).toBe(true);
    expect(second.suggestions.some((suggestion) => suggestion.kind === 'VEHICLE')).toBe(true);
  });

  it('does not flag two plates that merely share a prefix', async () => {
    await world.entities.resolve(resolveInput());
    const second = await world.entities.resolve(
      resolveInput({
        customer: { fullName: 'Meena S', phone: '98411 00003' },
        vehicle: { registration: 'TN 09 CA 5566' },
      }),
    );

    expect(second.suggestions).toEqual([]);
  });

  it('reports every validation problem at once rather than one at a time', async () => {
    await expect(
      world.entities.resolve(
        resolveInput({
          customer: { fullName: '', phone: '12345' },
          vehicle: { registration: 'NOTAPLATE' },
        }),
      ),
    ).rejects.toBeInstanceOf(EntityResolutionError);

    const problems = world.entities.validate({
      customer: { fullName: '', phone: '12345' },
      vehicle: { registration: 'NOTAPLATE' },
    });
    expect(problems.map((problem) => problem.field).sort()).toEqual([
      'customer.name',
      'customer.phone',
      'vehicle.registration',
    ]);
  });

  it('requires a phone when both the customer and the vehicle are new', async () => {
    await expect(
      world.entities.resolve(resolveInput({ customer: { fullName: 'Walk In', phone: null } })),
    ).rejects.toBeInstanceOf(EntityResolutionError);
  });

  it('accepts a BH-series registration', async () => {
    const resolution = await world.entities.resolve(
      resolveInput({ vehicle: { registration: '24 BH 4477 A' } }),
    );
    expect(resolution.registrationNormalised).toBe('24BH4477A');
  });
});

/* -------------------------------------------------------------------------- *
 * Draft mechanics
 * -------------------------------------------------------------------------- */

describe('JobCardDraft', () => {
  it('scores overall confidence as the mean across confirmable fields', () => {
    const draft = draftOf();
    expect(overallConfidence(draft)).toBeCloseTo(0.97, 2);
  });

  it('lists exactly the fields below the threshold', () => {
    const draft = draftOf({
      vehicle: {
        registration: { value: 'TN 09 BX 1234', confidence: 0.42, region: null },
        make: { value: 'Maruti Suzuki', confidence: 0.95, region: null },
        model: { value: 'Swift VDi', confidence: 0.6, region: null },
        odometerKm: { value: 78450, confidence: 0.99, region: null },
      },
    });

    const low = lowConfidenceFields(draft, 0.8).map((field) => field.path);
    expect(low).toEqual(['vehicle.registration', 'vehicle.model']);
  });

  it('raises a corrected field to full confidence and keeps its region', () => {
    const draft = draftOf({
      vehicle: {
        registration: {
          value: 'TN 09 BX 1234',
          confidence: 0.4,
          region: { x: 0.1, y: 0.2, width: 0.3, height: 0.05, page: 1 },
        },
        make: { value: null, confidence: 0.5, region: null },
        model: { value: null, confidence: 0.5, region: null },
        odometerKm: { value: null, confidence: 0.5, region: null },
      },
    });

    const { draft: corrected, previousValue } = applyCorrection(
      draft,
      'vehicle.registration',
      'TN 09 BX 4432',
    );

    expect(previousValue).toBe('TN 09 BX 1234');
    expect(corrected.vehicle.registration.value).toBe('TN 09 BX 4432');
    expect(corrected.vehicle.registration.confidence).toBe(1);
    expect(corrected.vehicle.registration.region?.x).toBe(0.1);
  });

  it('converts a rupee correction into paise', () => {
    const { draft } = applyCorrection(draftOf(), 'estimateLines.0.unitPricePaise', '₹3,200');
    expect(draft.estimateLines[0]?.unitPricePaise.value).toBe(320000);
  });

  it('clears a nullable field when corrected to nothing', () => {
    const { draft } = applyCorrection(draftOf(), 'vehicle.odometerKm', '');
    expect(draft.vehicle.odometerKm.value).toBeNull();
  });

  it('refuses a path that is not a correctable field', () => {
    expect(() => applyCorrection(draftOf(), 'vehicle.colour', 'red')).toThrow();
    expect(() => applyCorrection(draftOf(), 'complaints.99', 'x')).toThrow();
  });

  it('starts empty with zero confidence everywhere', () => {
    const empty = emptyJobCardDraft();
    expect(overallConfidence(empty)).toBe(0);
    expect(draftFields(empty).every((field) => field.confidence === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Confirmation surface
 * -------------------------------------------------------------------------- */

describe('staff confirmation surface', () => {
  it('numbers the summary and marks uncertain lines', () => {
    const draft = draftOf({
      vehicle: {
        registration: { value: 'TN 09 BX 1234', confidence: 0.42, region: null },
        make: { value: 'Maruti Suzuki', confidence: 0.95, region: null },
        model: { value: 'Swift VDi', confidence: 0.95, region: null },
        odometerKm: { value: 78450, confidence: 0.95, region: null },
      },
    });

    const summary = buildDraftSummary(draft, 0.8, 'en');
    expect(summary.uncertainCount).toBe(1);
    expect(summary.body).toContain('⚠');
    expect(summary.lines[0]?.index).toBe(1);

    const registrationLine = summary.lines.find((line) => line.path === 'vehicle.registration');
    expect(registrationLine?.uncertain).toBe(true);
    expect(pathForLine(summary, registrationLine?.index ?? 0)).toBe('vehicle.registration');
  });

  it('renders prices as rupees, not paise, for a human reading it', () => {
    const summary = buildDraftSummary(draftOf(), 0.8, 'en');
    const priceLine = summary.lines.find((line) => line.path.endsWith('unitPricePaise'));
    expect(priceLine?.value).toContain('2,450');
  });

  it.each([
    ['2 = TN 09 BX 4432', 2, 'TN 09 BX 4432'],
    ['2: TN 09 BX 4432', 2, 'TN 09 BX 4432'],
    ['2 - TN 09 BX 4432', 2, 'TN 09 BX 4432'],
    ['#2 = TN 09 BX 4432', 2, 'TN 09 BX 4432'],
    ['  10 =  4500  ', 10, '4500'],
  ])('parses %s as a correction to line %d', (input, index, value) => {
    const [correction] = parseQuickCorrection(input);
    expect(correction).toEqual({ lineIndex: index, value });
  });

  it('parses several corrections from one message', () => {
    expect(parseQuickCorrection('2 = TN 09 BX 4432\n6 = 81200')).toEqual([
      { lineIndex: 2, value: 'TN 09 BX 4432' },
      { lineIndex: 6, value: '81200' },
    ]);
  });

  it('does not mistake ordinary conversation for a correction', () => {
    expect(parseQuickCorrection('3 pads at 450 each')).toEqual([]);
    expect(parseQuickCorrection('looks right, go ahead')).toEqual([]);
    expect(parseQuickCorrection('call me on 9841100001')).toEqual([]);
  });

  it('round-trips the interactive button ids', () => {
    const draftId = '01920000-0000-7000-8000-000000000999';
    expect(parseDraftAction(DRAFT_ACTION_IDS.confirm(draftId))).toEqual({
      action: 'confirm',
      draftId,
    });
    expect(parseDraftAction(DRAFT_ACTION_IDS.discard(draftId))?.action).toBe('discard');
    expect(parseDraftAction('something:else')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * End to end: photo → draft → correction → confirmed OPEN card
 * -------------------------------------------------------------------------- */

describe('IntakeService', () => {
  let world: Harness;

  beforeEach(() => {
    world = build();
  });

  it('records a draft with its confidence and uncertain fields', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf({
        vehicle: {
          registration: { value: 'TN 09 BX 1234', confidence: 0.4, region: null },
          make: { value: 'Maruti Suzuki', confidence: 0.95, region: null },
          model: { value: 'Swift VDi', confidence: 0.95, region: null },
          odometerKm: { value: 78450, confidence: 0.95, region: null },
        },
      }),
      mediaId: 'media-1',
      extractorModel: 'claude-sonnet-5',
      actor: ADVISOR,
      traceId: TRACE,
    });

    expect(created.lowConfidencePaths).toContain('vehicle.registration');
    expect(created.needsConfirmation).toBe(true);
    expect(world.harness.world.eventsOfType('intake.draft_created')).toHaveLength(1);
  });

  it('walks photo → draft → correction → confirm → OPEN card with the correction applied', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf({
        vehicle: {
          registration: { value: 'TN 09 BX 1234', confidence: 0.4, region: null },
          make: { value: 'Maruti Suzuki', confidence: 0.95, region: null },
          model: { value: 'Swift VDi', confidence: 0.95, region: null },
          odometerKm: { value: 78450, confidence: 0.95, region: null },
        },
      }),
      mediaId: 'media-1',
      extractorModel: 'claude-sonnet-5',
      actor: ADVISOR,
      traceId: TRACE,
    });

    await world.service.correct({
      shopId: SHOP,
      draftId: created.draftId,
      path: 'vehicle.registration',
      value: 'TN 09 BX 4432',
      actor: ADVISOR,
      traceId: TRACE,
    });

    const confirmed = await world.service.confirm({
      shopId: SHOP,
      draftId: created.draftId,
      actor: ADVISOR,
      traceId: TRACE,
    });

    expect(confirmed.openFailure).toBeNull();
    expect(confirmed.correctedFields).toEqual(['vehicle.registration']);

    // The correction reached the vehicle record, not the OCR value.
    const vehicle = world.intake.vehicles.get(confirmed.vehicleId);
    expect(vehicle?.registrationNormalised).toBe('TN09BX4432');
    expect(vehicle?.registrationRaw).toBe('TN 09 BX 4432');

    // The card is genuinely OPEN, driven there by the transition service.
    expect(world.harness.world.cards.get(confirmed.jobCardId)?.state).toBe('OPEN');

    // Work items came from the complaints; the estimate carries the line.
    expect(confirmed.workItemIds).toHaveLength(2);
    expect(world.intake.estimates[0]?.lines).toHaveLength(1);
    expect(world.intake.estimates[0]?.lines[0]?.unitPricePaise).toBe(245000);
  });

  it('leaves an audit trail naming the OCR source and the human correction', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf(),
      mediaId: 'media-1',
      extractorModel: 'claude-sonnet-5',
      actor: ADVISOR,
      traceId: TRACE,
    });
    await world.service.correct({
      shopId: SHOP,
      draftId: created.draftId,
      path: 'customer.name',
      value: 'Anand K',
      actor: ADVISOR,
      traceId: TRACE,
    });
    await world.service.confirm({
      shopId: SHOP,
      draftId: created.draftId,
      actor: ADVISOR,
      traceId: TRACE,
    });

    const actions = world.harness.world.auditActions();
    expect(actions).toContain('intake.draft_created');
    expect(actions).toContain('intake.draft_corrected');
    expect(actions).toContain('intake.draft_confirmed');

    const confirmEntry = [...world.harness.world.auditByShop.values()]
      .flat()
      .find((entry) => entry.action === 'intake.draft_confirmed');
    const payload = confirmEntry?.payload as {
      extractorModel?: string;
      correctedFields?: string[];
    };
    expect(payload.extractorModel).toBe('claude-sonnet-5');
    expect(payload.correctedFields).toEqual(['customer.name']);
  });

  it('emits intake.draft_confirmed for the workers to consume', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf(),
      actor: ADVISOR,
      traceId: TRACE,
    });
    await world.service.confirm({
      shopId: SHOP,
      draftId: created.draftId,
      actor: ADVISOR,
      traceId: TRACE,
    });

    expect(world.harness.world.eventsOfType('intake.draft_confirmed')).toHaveLength(1);
  });

  it('refuses to confirm the same draft twice', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf(),
      actor: ADVISOR,
      traceId: TRACE,
    });
    await world.service.confirm({
      shopId: SHOP,
      draftId: created.draftId,
      actor: ADVISOR,
      traceId: TRACE,
    });

    await expect(
      world.service.confirm({
        shopId: SHOP,
        draftId: created.draftId,
        actor: ADVISOR,
        traceId: TRACE,
      }),
    ).rejects.toThrow(/can no longer be confirmed/);

    // Exactly one card, whatever the customer taps.
    expect(world.intake.jobCards.size).toBe(1);
  });

  it('discards a draft without creating anything', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf(),
      actor: ADVISOR,
      traceId: TRACE,
    });
    await world.service.discard({
      shopId: SHOP,
      draftId: created.draftId,
      actor: ADVISOR,
      traceId: TRACE,
    });

    expect(world.intake.jobCards.size).toBe(0);
    expect(world.intake.vehicles.size).toBe(0);
    await expect(
      world.service.confirm({
        shopId: SHOP,
        draftId: created.draftId,
        actor: ADVISOR,
        traceId: TRACE,
      }),
    ).rejects.toThrow();
  });

  it('rolls the whole confirmation back when entity resolution fails', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf({
        vehicle: {
          registration: { value: 'NOT A PLATE', confidence: 0.3, region: null },
          make: { value: null, confidence: 0.3, region: null },
          model: { value: null, confidence: 0.3, region: null },
          odometerKm: { value: null, confidence: 0.3, region: null },
        },
      }),
      actor: ADVISOR,
      traceId: TRACE,
    });

    await expect(
      world.service.confirm({
        shopId: SHOP,
        draftId: created.draftId,
        actor: ADVISOR,
        traceId: TRACE,
      }),
    ).rejects.toBeInstanceOf(EntityResolutionError);

    // No half-built card, and the draft is still correctable.
    expect(world.intake.jobCards.size).toBe(0);
    expect(world.intake.customerRows.size).toBe(0);
    const draft = await world.service.load(SHOP, created.draftId);
    expect(draft?.status).toBe('AWAITING_CONFIRMATION');
  });

  it('finds the open draft a thread’s correction refers to', async () => {
    const created = await world.service.recordDraft({
      shopId: SHOP,
      source: 'PHOTO',
      draft: draftOf(),
      conversationId: 'conv-1',
      actor: ADVISOR,
      traceId: TRACE,
    });

    const open = await world.service.openDraftForConversation(SHOP, 'conv-1');
    expect(open?.id).toBe(created.draftId);

    await world.service.confirm({
      shopId: SHOP,
      draftId: created.draftId,
      actor: ADVISOR,
      traceId: TRACE,
    });
    expect(await world.service.openDraftForConversation(SHOP, 'conv-1')).toBeNull();
  });
});
