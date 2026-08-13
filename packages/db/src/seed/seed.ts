import { createStoragePort, mediaKey, type StoragePort } from '@serviceloop/adapters';
import { type Env, defaultShopConfig, getEnv } from '@serviceloop/config';
import {
  GuardrailService,
  JobCardTransitionService,
  type Actor,
  WorkItemTransitionService,
} from '@serviceloop/domain';
import {
  applyRateBp,
  lineTotal,
  normalisePhone,
  normaliseRegistration,
  sumPaise,
  uuidv7,
} from '@serviceloop/shared';
import { eq, sql } from 'drizzle-orm';
import { type Database, PgUnitOfWork, type Tx } from '../client';
import { blindIndex } from '../crypto/pii';
import {
  consents,
  customers,
  estimateLines,
  estimates,
  jobCards,
  mediaAssets,
  shops,
  staff,
  vehicles,
  workItems,
} from '../schema';
import { AuditService } from '../services/audit-service';
import { OutboxService } from '../services/outbox-service';
import { PgJobCardStore } from '../stores/job-card-store';
import { PgShopConfigStore } from '../stores/shop-config-store';
import { PgWorkItemStore } from '../stores/work-item-store';
import {
  DEMO_ADVISOR,
  DEMO_CUSTOMERS,
  DEMO_JOB_CARDS,
  DEMO_OWNER,
  DEMO_PRICE_LIST,
  DEMO_SHOP,
  DEMO_SHOP_ID,
  DEMO_STAFF,
  DEMO_TECHNICIAN,
  type JobCardFixture,
} from './fixtures';

/**
 * Seeds the demo shop (phase 1.10).
 *
 * Job cards are not written into their target state — they are *driven* there
 * through `JobCardTransitionService` and `WorkItemTransitionService`. The seed
 * therefore produces a genuine hash-chained audit trail and real outbox events,
 * which is what makes the demo meaningful rather than decorative.
 */

export interface SeedResult {
  readonly shopId: string;
  readonly staff: number;
  readonly customers: number;
  readonly vehicles: number;
  readonly jobCards: number;
  readonly workItems: number;
  readonly estimates: number;
  readonly mediaAssets: number;
  readonly transitions: number;
  readonly skipped: boolean;
}

const SEED_ACTOR: Actor = { type: 'SYSTEM', id: null, displayName: 'seed' };
const SEED_TRACE = 'seed';

export async function isAlreadySeeded(db: Database): Promise<boolean> {
  const rows = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, DEMO_SHOP_ID));
  return rows.length > 0;
}

export async function seedDemoShop(
  db: Database,
  options: { env?: Env; storage?: StoragePort; log?: (message: string) => void } = {},
): Promise<SeedResult> {
  const env = options.env ?? getEnv();
  const log = options.log ?? ((message: string) => console.info(`[seed] ${message}`));

  if (await isAlreadySeeded(db)) {
    log('demo shop already present — nothing to do (use `pnpm db:seed --reset` to rebuild)');
    return {
      shopId: DEMO_SHOP_ID,
      staff: 0,
      customers: 0,
      vehicles: 0,
      jobCards: 0,
      workItems: 0,
      estimates: 0,
      mediaAssets: 0,
      transitions: 0,
      skipped: true,
    };
  }

  const storage = options.storage ?? createStoragePort(env);
  await storage.ensureBucket();

  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db);
  const outbox = new OutboxService(db);
  const configStore = new PgShopConfigStore();

  const guardrails = new GuardrailService({ uow, store: configStore, audit, outbox });
  const cardService = new JobCardTransitionService({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
  });
  const itemService = new WorkItemTransitionService({
    uow,
    items: new PgWorkItemStore(),
    audit,
    outbox,
  });

  await db.transaction(async (tx) => {
    await insertShopAndStaff(tx);
    await insertCustomersAndVehicles(tx);
    await insertJobCards(tx);
  });
  log(`inserted ${DEMO_CUSTOMERS.length} customers and ${DEMO_JOB_CARDS.length} job cards`);

  // The config row is created through the guardrail service so its creation is
  // audited exactly like any later change.
  await guardrails.validateAndPatch(
    DEMO_SHOP_ID,
    defaultShopConfig(DEMO_SHOP.timezone) as unknown as Record<string, unknown>,
    { type: 'STAFF', id: DEMO_OWNER.id, displayName: DEMO_OWNER.fullName },
    SEED_TRACE,
  );
  log('shop config written at conservative defaults (all flows L0_SHADOW)');

  const mediaCount = await uploadMedia(db, storage);
  log(`uploaded ${mediaCount} media assets to ${storage.bucket} via ${storage.driver}`);

  let transitions = 0;
  for (const fixture of DEMO_JOB_CARDS) {
    transitions += await driveCard(db, cardService, itemService, fixture);
  }
  log(`drove ${transitions} transitions across ${DEMO_JOB_CARDS.length} cards`);

  const counts = await countSeeded(db);
  return { ...counts, shopId: DEMO_SHOP_ID, transitions, skipped: false };
}

async function insertShopAndStaff(tx: Tx): Promise<void> {
  await tx.insert(shops).values({
    id: DEMO_SHOP.id,
    name: DEMO_SHOP.name,
    legalName: DEMO_SHOP.legalName,
    city: DEMO_SHOP.city,
    addressLine: DEMO_SHOP.addressLine,
    timezone: DEMO_SHOP.timezone,
    contactPhone: DEMO_SHOP.contactPhone,
    gstNumber: DEMO_SHOP.gstNumber,
  });

  for (const member of DEMO_STAFF) {
    await tx.insert(staff).values({
      id: member.id,
      shopId: DEMO_SHOP_ID,
      role: member.role,
      fullName: member.fullName,
      phoneEncrypted: member.phone,
      phoneHash: blindIndex(DEMO_SHOP_ID, member.phone),
      preferredLanguage: member.preferredLanguage,
    });
  }
}

async function insertCustomersAndVehicles(tx: Tx): Promise<void> {
  for (const fixture of DEMO_CUSTOMERS) {
    const phone = normalisePhone(fixture.phone);
    if (!phone.ok) throw new Error(`Seed fixture has an invalid phone: ${fixture.phone}`);

    await tx.insert(customers).values({
      id: fixture.id,
      shopId: DEMO_SHOP_ID,
      fullNameEncrypted: fixture.fullName,
      phoneEncrypted: phone.value,
      phoneHash: blindIndex(DEMO_SHOP_ID, phone.value),
      preferredLanguage: fixture.preferredLanguage,
      whatsappOptIn: fixture.whatsappOptIn,
    });

    // Consent state mirrors the opt-in flag: SERVICE granted for opted-in
    // customers, still PENDING for the rest. Nothing is ever assumed.
    await tx.insert(consents).values({
      shopId: DEMO_SHOP_ID,
      customerId: fixture.id,
      purpose: 'SERVICE',
      status: fixture.whatsappOptIn ? 'GRANTED' : 'PENDING',
      channel: 'WHATSAPP',
      evidence: fixture.whatsappOptIn
        ? 'Customer replied YES to the opt-in prompt at the service desk'
        : 'Opt-in requested, no reply yet',
      grantedAt: fixture.whatsappOptIn ? new Date() : null,
    });

    const registration = normaliseRegistration(fixture.vehicle.registrationRaw);
    if (!registration.ok) {
      throw new Error(
        `Seed fixture has an invalid registration: ${fixture.vehicle.registrationRaw}`,
      );
    }

    await tx.insert(vehicles).values({
      id: fixture.vehicle.id,
      shopId: DEMO_SHOP_ID,
      customerId: fixture.id,
      registrationRaw: fixture.vehicle.registrationRaw,
      registrationNormalised: registration.value.normalised,
      make: fixture.vehicle.make,
      model: fixture.vehicle.model,
      modelYear: fixture.vehicle.modelYear,
      fuelType: fixture.vehicle.fuelType,
      colour: fixture.vehicle.colour,
      odometerKm: fixture.vehicle.odometerKm,
    });
  }
}

async function insertJobCards(tx: Tx): Promise<void> {
  for (const fixture of DEMO_JOB_CARDS) {
    const customer = DEMO_CUSTOMERS[fixture.customerIndex];
    if (customer === undefined)
      throw new Error(`Fixture ${fixture.code} references a missing customer`);

    await tx.insert(jobCards).values({
      id: fixture.id,
      shopId: DEMO_SHOP_ID,
      customerId: customer.id,
      vehicleId: customer.vehicle.id,
      code: fixture.code,
      state: 'DRAFT',
      source: fixture.source,
      complaintText: fixture.complaintText,
      odometerKm: customer.vehicle.odometerKm,
      assignedAdvisorId: DEMO_ADVISOR.id,
      assignedTechnicianId: DEMO_TECHNICIAN.id,
    });

    let sequence = 0;
    for (const item of fixture.workItems) {
      await tx.insert(workItems).values({
        id: item.id,
        shopId: DEMO_SHOP_ID,
        jobCardId: fixture.id,
        title: item.title,
        description: item.description,
        state: 'PROPOSED',
        requiresApproval: item.requiresApproval,
        technicianNote: item.technicianNote,
        estimatedMinutes: item.estimatedMinutes,
        sequence,
      });
      sequence += 1;
    }

    await insertEstimate(tx, fixture);
  }
}

async function insertEstimate(tx: Tx, fixture: JobCardFixture): Promise<void> {
  const estimateId = uuidv7();
  const lines = fixture.workItems.flatMap((item) =>
    item.lines.map((line) => ({
      ...line,
      workItemId: item.id,
      lineTotalPaise: lineTotal(line.quantityMilli, line.unitPricePaise),
      taxRateBp: line.kind === 'LABOUR' ? 1800 : 2800,
    })),
  );

  const subtotal = sumPaise(lines.map((line) => line.lineTotalPaise));
  const tax = sumPaise(lines.map((line) => applyRateBp(line.lineTotalPaise, line.taxRateBp)));

  await tx.insert(estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId: fixture.id,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: subtotal,
    taxPaise: tax,
    totalPaise: subtotal + tax,
    createdById: DEMO_ADVISOR.id,
  });

  let sequence = 0;
  for (const line of lines) {
    await tx.insert(estimateLines).values({
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: line.workItemId,
      kind: line.kind,
      description: line.description,
      quantityMilli: line.quantityMilli,
      unitPricePaise: line.unitPricePaise,
      lineTotalPaise: line.lineTotalPaise,
      taxRateBp: line.taxRateBp,
      sequence,
    });
    sequence += 1;
  }
}

/** Placeholder evidence photos, rendered as SVG so they are real, viewable images. */
async function uploadMedia(db: Database, storage: StoragePort): Promise<number> {
  let count = 0;

  for (const fixture of DEMO_JOB_CARDS) {
    for (const media of fixture.media) {
      const workItem = fixture.workItems[media.workItemIndex];
      const key = mediaKey({
        shopId: DEMO_SHOP_ID,
        jobCardId: fixture.id,
        mediaId: media.id,
        kind: 'PHOTO',
        extension: 'svg',
      });
      const body = Buffer.from(placeholderSvg(fixture.code, media.caption), 'utf8');
      const put = await storage.put({
        key,
        body,
        contentType: 'image/svg+xml',
        metadata: { jobCard: fixture.code, mediaId: media.id },
      });

      await db.insert(mediaAssets).values({
        id: media.id,
        shopId: DEMO_SHOP_ID,
        jobCardId: fixture.id,
        workItemId: workItem?.id ?? null,
        kind: 'PHOTO',
        bucket: put.bucket,
        storageKey: put.key,
        contentType: 'image/svg+xml',
        sizeBytes: put.sizeBytes,
        checksumSha256: put.checksumSha256,
        caption: media.caption,
        capturedById: DEMO_TECHNICIAN.id,
        capturedAt: new Date(),
      });
      count += 1;
    }
  }

  // Phase 3 reads the price list from here through the same StoragePort.
  const priceListBody = Buffer.from(JSON.stringify(DEMO_PRICE_LIST, null, 2), 'utf8');
  const priceListKey = `shops/${DEMO_SHOP_ID}/knowledge/price-list.json`;
  const priceListPut = await storage.put({
    key: priceListKey,
    body: priceListBody,
    contentType: 'application/json',
    metadata: { document: 'price-list', version: DEMO_PRICE_LIST.updatedAt },
  });

  await db.insert(mediaAssets).values({
    shopId: DEMO_SHOP_ID,
    jobCardId: null,
    kind: 'DOCUMENT',
    bucket: priceListPut.bucket,
    storageKey: priceListPut.key,
    contentType: 'application/json',
    sizeBytes: priceListPut.sizeBytes,
    checksumSha256: priceListPut.checksumSha256,
    caption: 'Shop price list (knowledge document for the agent)',
    capturedById: DEMO_OWNER.id,
    capturedAt: new Date(),
  });

  return count + 1;
}

function placeholderSvg(code: string, caption: string): string {
  const wrapped = caption.length > 46 ? `${caption.slice(0, 43)}…` : caption;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">',
    '<rect width="640" height="400" fill="#1f2937"/>',
    '<rect x="16" y="16" width="608" height="368" fill="none" stroke="#4b5563" stroke-width="2"/>',
    '<text x="40" y="180" fill="#f9fafb" font-family="system-ui,sans-serif" font-size="26">',
    escapeXml(wrapped),
    '</text>',
    '<text x="40" y="228" fill="#9ca3af" font-family="system-ui,sans-serif" font-size="18">',
    `${escapeXml(code)} · demo evidence photo`,
    '</text>',
    '</svg>',
  ].join('');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function driveCard(
  db: Database,
  cardService: JobCardTransitionService<Tx>,
  itemService: WorkItemTransitionService<Tx>,
  fixture: JobCardFixture,
): Promise<number> {
  let transitions = 0;

  for (const step of fixture.script) {
    if (step.kind === 'card') {
      await cardService.transition({
        shopId: DEMO_SHOP_ID,
        jobCardId: fixture.id,
        event: step.event,
        actor: SEED_ACTOR,
        traceId: SEED_TRACE,
        meta: { seeded: true },
      });
      transitions += 1;
      continue;
    }

    if (step.kind === 'items') {
      for (const item of fixture.workItems) {
        await itemService.transition({
          shopId: DEMO_SHOP_ID,
          workItemId: item.id,
          event: step.event,
          actor: step.event === 'APPROVE' ? { type: 'CUSTOMER', id: null } : SEED_ACTOR,
          traceId: SEED_TRACE,
        });
        transitions += 1;
      }
      continue;
    }

    await db
      .update(estimates)
      .set({
        status: step.status,
        acceptedAt: step.status === 'ACCEPTED' ? new Date() : null,
      })
      .where(eq(estimates.jobCardId, fixture.id));
  }

  return transitions;
}

async function countSeeded(
  db: Database,
): Promise<Omit<SeedResult, 'shopId' | 'transitions' | 'skipped'>> {
  const count = async (table: string): Promise<number> => {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)} where shop_id = ${DEMO_SHOP_ID}`,
    );
    return Number(result.rows[0]?.count ?? 0);
  };

  return {
    staff: await count('staff'),
    customers: await count('customers'),
    vehicles: await count('vehicles'),
    jobCards: await count('job_cards'),
    workItems: await count('work_items'),
    estimates: await count('estimates'),
    mediaAssets: await count('media_assets'),
  };
}
