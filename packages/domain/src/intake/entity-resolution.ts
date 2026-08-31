import {
  boundedEditDistance,
  type Clock,
  type EventEnvelope,
  type Language,
  normalisePhone,
  normaliseRegistration,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';

/**
 * Entity resolution (phase 2.8).
 *
 * A workshop's natural keys are the vehicle's registration and the customer's
 * phone number, and both arrive mangled: from OCR of a handwritten card, from a
 * customer typing on a phone keyboard, from an advisor in a hurry. Normalising
 * them is `@serviceloop/shared`'s job. Deciding *which existing record they
 * mean* is this file's.
 *
 * The governing rule (phase brief): **ambiguous matches queue a merge
 * suggestion for the advisor instead of guessing.** Merging two customers who
 * turn out to be different people mixes two service histories and two consent
 * records — a mistake that is expensive to find and near-impossible to unwind.
 * So this service merges only on an exact, unambiguous key, and everything else
 * becomes a suggestion a human decides on.
 */

export interface VehicleMatch {
  readonly id: string;
  readonly customerId: string;
  readonly registrationNormalised: string;
  readonly make: string | null;
  readonly model: string | null;
}

export interface CustomerMatch {
  readonly id: string;
  readonly fullName: string;
  readonly preferredLanguage: Language;
}

export interface EntityLookup<Tx> {
  findVehicleByRegistration(
    tx: Tx,
    shopId: string,
    registrationNormalised: string,
  ): Promise<VehicleMatch | null>;

  /**
   * Registrations sharing a prefix, for near-miss detection. Scoped by the
   * leading characters so this stays an index scan rather than a table scan.
   */
  findVehiclesByRegistrationPrefix(
    tx: Tx,
    shopId: string,
    prefix: string,
    limit: number,
  ): Promise<readonly VehicleMatch[]>;

  findCustomerByPhone(tx: Tx, shopId: string, phoneE164: string): Promise<CustomerMatch | null>;
  findCustomerById(tx: Tx, shopId: string, customerId: string): Promise<CustomerMatch | null>;

  createCustomer(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly fullName: string;
      readonly phoneE164: string;
      readonly preferredLanguage: Language;
    },
  ): Promise<void>;

  createVehicle(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly customerId: string;
      readonly registrationRaw: string;
      readonly registrationNormalised: string;
      readonly make: string | null;
      readonly model: string | null;
      readonly odometerKm: number | null;
    },
  ): Promise<void>;

  recordMergeSuggestion(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly kind: 'CUSTOMER' | 'VEHICLE';
      readonly primaryEntityId: string;
      readonly candidateEntityId: string;
      readonly reason: string;
      readonly scoreMilli: number;
      readonly context: Readonly<Record<string, unknown>>;
      readonly draftId: string | null;
    },
  ): Promise<boolean>;
}

export interface ResolveInput {
  readonly shopId: string;
  readonly customer: {
    readonly fullName: string;
    /** Raw, as written on the card or typed. Normalised here. */
    readonly phone: string | null;
    readonly preferredLanguage?: Language;
  };
  readonly vehicle: {
    readonly registration: string;
    readonly make?: string | null;
    readonly model?: string | null;
    readonly odometerKm?: number | null;
  };
  readonly draftId?: string | null;
  readonly actor: Actor;
  readonly traceId: string;
  readonly defaultLanguage: Language;
}

export type ResolutionProblem =
  | { readonly field: 'vehicle.registration'; readonly code: string; readonly reason: string }
  | { readonly field: 'customer.phone'; readonly code: string; readonly reason: string }
  | { readonly field: 'customer.name'; readonly code: string; readonly reason: string };

export interface MergeSuggestionRecord {
  readonly id: string;
  readonly kind: 'CUSTOMER' | 'VEHICLE';
  readonly primaryEntityId: string;
  readonly candidateEntityId: string;
  readonly reason: string;
}

export interface Resolution {
  readonly customerId: string;
  readonly vehicleId: string;
  readonly customerCreated: boolean;
  readonly vehicleCreated: boolean;
  readonly registrationNormalised: string;
  readonly phoneE164: string | null;
  readonly suggestions: readonly MergeSuggestionRecord[];
}

export class EntityResolutionError extends Error {
  constructor(readonly problems: readonly ResolutionProblem[]) {
    super(`Entity resolution failed: ${problems.map((problem) => problem.reason).join('; ')}`);
    this.name = 'EntityResolutionError';
  }
}

export interface EntityResolutionDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly lookup: EntityLookup<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

/** How close two registrations must be to be worth an advisor's attention. */
const NEAR_MISS_DISTANCE = 1;
const NEAR_MISS_PREFIX_LENGTH = 4;
const NEAR_MISS_SCAN_LIMIT = 50;

export class EntityResolutionService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: EntityResolutionDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Validation only — the console form calls this before showing errors. */
  validate(input: Pick<ResolveInput, 'customer' | 'vehicle'>): readonly ResolutionProblem[] {
    const problems: ResolutionProblem[] = [];

    const registration = normaliseRegistration(input.vehicle.registration);
    if (!registration.ok) {
      problems.push({
        field: 'vehicle.registration',
        code: registration.error.kind,
        reason: describeRegistrationError(input.vehicle.registration, registration.error.kind),
      });
    }

    if (input.customer.phone !== null && input.customer.phone.trim().length > 0) {
      const phone = normalisePhone(input.customer.phone);
      if (!phone.ok) {
        problems.push({
          field: 'customer.phone',
          code: phone.error.kind,
          reason: `"${input.customer.phone}" is not a valid Indian mobile number (${phone.error.kind})`,
        });
      }
    }

    if (input.customer.fullName.trim().length === 0) {
      problems.push({
        field: 'customer.name',
        code: 'REQUIRED',
        reason: 'A job card needs a customer name',
      });
    }

    return problems;
  }

  async resolve(input: ResolveInput): Promise<Resolution> {
    return this.deps.uow.transaction(async (tx) => this.resolveIn(tx, input));
  }

  /** Same work inside a caller's transaction — draft confirmation needs this. */
  async resolveIn(tx: Tx, input: ResolveInput): Promise<Resolution> {
    const problems = this.validate(input);
    if (problems.length > 0) throw new EntityResolutionError(problems);

    const registration = normaliseRegistration(input.vehicle.registration);
    if (!registration.ok) throw new EntityResolutionError(problems);
    const registrationNormalised = registration.value.normalised;

    const phoneResult =
      input.customer.phone === null || input.customer.phone.trim().length === 0
        ? null
        : normalisePhone(input.customer.phone);
    const phoneE164 = phoneResult !== null && phoneResult.ok ? phoneResult.value : null;

    const suggestions: MergeSuggestionRecord[] = [];

    const existingVehicle = await this.deps.lookup.findVehicleByRegistration(
      tx,
      input.shopId,
      registrationNormalised,
    );
    const existingCustomer =
      phoneE164 === null
        ? null
        : await this.deps.lookup.findCustomerByPhone(tx, input.shopId, phoneE164);

    /* ------------------------------------------------------------------ *
     * The vehicle is the stronger key: a registration is unique per shop,
     * whereas one phone can belong to a household with three cars.
     * ------------------------------------------------------------------ */
    if (existingVehicle !== null) {
      /*
       * A known car arriving with a number that is not its owner's is the
       * central ambiguity of this whole file. It means one of: the same person
       * on a new handset, a sale, a family member dropping the car off, or a
       * digit typed wrong. Those have different right answers and only a human
       * knows which applies.
       *
       * So: the *visit* stays attached to the record the car already has (its
       * service history is the thing worth protecting), the person who
       * actually made contact gets a customer record of their own so future
       * messages from that number are recognised, and an advisor is handed the
       * question. Nothing is merged, and nothing is thrown away.
       */
      let counterpartId: string | null = existingCustomer?.id ?? null;

      if (counterpartId === null && phoneE164 !== null) {
        counterpartId = uuidv7();
        await this.deps.lookup.createCustomer(tx, {
          id: counterpartId,
          shopId: input.shopId,
          fullName: input.customer.fullName.trim(),
          phoneE164,
          preferredLanguage: input.customer.preferredLanguage ?? input.defaultLanguage,
        });
      }

      if (counterpartId !== null && counterpartId !== existingVehicle.customerId) {
        const suggestion = await this.suggest(tx, input, {
          kind: 'CUSTOMER',
          primaryEntityId: existingVehicle.customerId,
          candidateEntityId: counterpartId,
          reason: `Vehicle ${registrationNormalised} is on record against a different customer than the phone number on this job card`,
          scoreMilli: 700,
          context: {
            registrationNormalised,
            vehicleId: existingVehicle.id,
            recordedOwnerId: existingVehicle.customerId,
            phoneOwnerId: counterpartId,
          },
        });
        if (suggestion !== null) suggestions.push(suggestion);
      }

      // Keep serving the visit against the record the vehicle already has, so
      // the card joins the car's real service history rather than starting a
      // parallel one.
      return {
        customerId: existingVehicle.customerId,
        vehicleId: existingVehicle.id,
        customerCreated: false,
        vehicleCreated: false,
        registrationNormalised,
        phoneE164,
        suggestions,
      };
    }

    /* ------------------------------------------------------------------ *
     * New vehicle. Before creating it, check for an OCR near-miss against
     * the vehicles this shop already knows.
     * ------------------------------------------------------------------ */
    const nearMiss = await this.findNearMissVehicle(tx, input.shopId, registrationNormalised);

    let customerId: string;
    let customerCreated = false;

    if (existingCustomer !== null) {
      customerId = existingCustomer.id;
    } else {
      if (phoneE164 === null) {
        throw new EntityResolutionError([
          {
            field: 'customer.phone',
            code: 'PHONE_REQUIRED_FOR_NEW_CUSTOMER',
            reason:
              'This vehicle and this customer are both new, so a phone number is required to identify them',
          },
        ]);
      }
      customerId = uuidv7();
      customerCreated = true;
      await this.deps.lookup.createCustomer(tx, {
        id: customerId,
        shopId: input.shopId,
        fullName: input.customer.fullName.trim(),
        phoneE164,
        preferredLanguage: input.customer.preferredLanguage ?? input.defaultLanguage,
      });
    }

    const vehicleId = uuidv7();
    await this.deps.lookup.createVehicle(tx, {
      id: vehicleId,
      shopId: input.shopId,
      customerId,
      // The raw string is kept exactly as written: when a normalisation turns
      // out to be wrong, the original is the only way to tell.
      registrationRaw: input.vehicle.registration,
      registrationNormalised,
      make: input.vehicle.make ?? null,
      model: input.vehicle.model ?? null,
      odometerKm: input.vehicle.odometerKm ?? null,
    });

    if (nearMiss !== null) {
      const suggestion = await this.suggest(tx, input, {
        kind: 'VEHICLE',
        primaryEntityId: nearMiss.vehicle.id,
        candidateEntityId: vehicleId,
        reason: `Registration ${registrationNormalised} differs by ${nearMiss.distance} character from ${nearMiss.vehicle.registrationNormalised} already on record — one may be a misread`,
        scoreMilli: 900,
        context: {
          existingRegistration: nearMiss.vehicle.registrationNormalised,
          newRegistration: registrationNormalised,
          distance: nearMiss.distance,
        },
      });
      if (suggestion !== null) suggestions.push(suggestion);
    }

    await this.deps.audit.append(tx, {
      shopId: input.shopId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'entity.resolved',
      entityType: 'Vehicle',
      entityId: vehicleId,
      payload: {
        registrationNormalised,
        customerId,
        customerCreated,
        vehicleCreated: true,
        suggestions: suggestions.map((suggestion) => suggestion.id),
      },
      traceId: input.traceId,
    });

    return {
      customerId,
      vehicleId,
      customerCreated,
      vehicleCreated: true,
      registrationNormalised,
      phoneE164,
      suggestions,
    };
  }

  private async findNearMissVehicle(
    tx: Tx,
    shopId: string,
    registrationNormalised: string,
  ): Promise<{ vehicle: VehicleMatch; distance: number } | null> {
    // The state code and RTO number are the least error-prone part of a plate,
    // so they make a good prefix to scan within.
    const prefix = registrationNormalised.slice(0, NEAR_MISS_PREFIX_LENGTH);
    const candidates = await this.deps.lookup.findVehiclesByRegistrationPrefix(
      tx,
      shopId,
      prefix,
      NEAR_MISS_SCAN_LIMIT,
    );

    let best: { vehicle: VehicleMatch; distance: number } | null = null;
    for (const candidate of candidates) {
      if (candidate.registrationNormalised === registrationNormalised) continue;
      const distance = boundedEditDistance(
        registrationNormalised,
        candidate.registrationNormalised,
        NEAR_MISS_DISTANCE,
      );
      if (distance <= NEAR_MISS_DISTANCE && (best === null || distance < best.distance)) {
        best = { vehicle: candidate, distance };
      }
    }
    return best;
  }

  private async suggest(
    tx: Tx,
    input: ResolveInput,
    suggestion: {
      kind: 'CUSTOMER' | 'VEHICLE';
      primaryEntityId: string;
      candidateEntityId: string;
      reason: string;
      scoreMilli: number;
      context: Readonly<Record<string, unknown>>;
    },
  ): Promise<MergeSuggestionRecord | null> {
    const id = uuidv7();
    const inserted = await this.deps.lookup.recordMergeSuggestion(tx, {
      id,
      shopId: input.shopId,
      kind: suggestion.kind,
      primaryEntityId: suggestion.primaryEntityId,
      candidateEntityId: suggestion.candidateEntityId,
      reason: suggestion.reason,
      scoreMilli: suggestion.scoreMilli,
      context: suggestion.context,
      draftId: input.draftId ?? null,
    });

    // The same pair can be proposed on every visit; the store's unique index
    // keeps one open suggestion rather than a growing pile of identical ones.
    if (!inserted) return null;

    await this.deps.audit.append(tx, {
      shopId: input.shopId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'merge_suggestion.created',
      entityType: 'MergeSuggestion',
      entityId: id,
      payload: {
        kind: suggestion.kind,
        primaryEntityId: suggestion.primaryEntityId,
        candidateEntityId: suggestion.candidateEntityId,
        reason: suggestion.reason,
      },
      traceId: input.traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'merge_suggestion.created',
      occurredAt: this.clock.now().toISOString(),
      shopId: input.shopId,
      traceId: input.traceId,
      payload: {
        suggestionId: id,
        kind: suggestion.kind,
        candidateIds: [suggestion.primaryEntityId, suggestion.candidateEntityId],
        reason: suggestion.reason,
        actor: { type: input.actor.type, id: input.actor.id },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);

    return {
      id,
      kind: suggestion.kind,
      primaryEntityId: suggestion.primaryEntityId,
      candidateEntityId: suggestion.candidateEntityId,
      reason: suggestion.reason,
    };
  }
}

function describeRegistrationError(raw: string, kind: string): string {
  switch (kind) {
    case 'EMPTY':
      return 'A job card needs a vehicle registration number';
    case 'UNKNOWN_STATE_CODE':
      return `"${raw}" starts with a state code that is not an Indian RTO code`;
    default:
      return `"${raw}" is not a recognisable Indian registration number`;
  }
}
