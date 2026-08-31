import type { Language } from '@serviceloop/shared';

/**
 * The golden job-card set (phase 2.5).
 *
 * Twelve cards, each defined **once** as data. The HTML template renders from
 * that data and the expected extraction is derived from the same data, so the
 * fixture and its answer key physically cannot drift apart — the failure mode
 * that makes hand-maintained OCR fixtures worthless after three months.
 *
 * The set is chosen to cover what actually walks into an Indian workshop:
 * ruled register pages, carbon-copy pads, printed forms filled in by hand,
 * Tamil and Hindi item names, ditto marks, struck-through corrections, rupee
 * shorthand, a BH-series plate, and a card with no prices at all.
 */

export type CardLayout =
  /** Lined register page, everything handwritten. */
  | 'ruled-register'
  /** Blue carbon-copy pad with a doubled impression. */
  | 'carbon-pad'
  /** Printed form, handwritten values. */
  | 'printed-form'
  /** Narrow thermal-style slip. */
  | 'receipt-slip'
  /** Two-column workshop pad with a Qty/Rate table. */
  | 'two-column-pad';

export interface CardLine {
  readonly description: string;
  /** Rendered quantity cell. `null` renders blank and means one. */
  readonly qty: number | null;
  /** Rupees as written. `null` renders an empty rate cell. */
  readonly rateRupees: number | null;
  /** Renders as a ditto mark repeating the line above. */
  readonly ditto?: boolean;
  /** Renders struck through, with `replacement` written beside it. */
  readonly struckThrough?: string;
}

export interface CardData {
  readonly customerName: string;
  readonly phone: string | null;
  /** Exactly as written on the card, spacing and all. */
  readonly registrationWritten: string;
  /** What entity resolution must end up with. */
  readonly registrationExpected: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly odometerKm: number | null;
  readonly complaints: readonly string[];
  readonly lines: readonly CardLine[];
  readonly advisorName: string | null;
  /** As written; the extractor must not turn a phrase into a timestamp. */
  readonly promisedAt: string | null;
}

export interface CardFixture {
  readonly id: string;
  readonly layout: CardLayout;
  readonly language: Language;
  /** Shop name printed on the letterhead, where the layout has one. */
  readonly shopName: string;
  readonly cardNumber: string;
  readonly dateWritten: string;
  readonly data: CardData;
  /** One line on what this fixture is for, printed by the eval. */
  readonly exercises: string;
}

export const CARD_FIXTURES: readonly CardFixture[] = [
  {
    id: '01-ruled-register-plain',
    layout: 'ruled-register',
    language: 'en',
    shopName: 'Sri Murugan Auto Works',
    cardNumber: 'JC-1042',
    dateWritten: '14/03',
    exercises: 'The baseline: clean handwriting on a lined register page.',
    data: {
      customerName: 'Ravi Kumar',
      phone: '9840012345',
      registrationWritten: 'TN 09 BX 4432',
      registrationExpected: 'TN09BX4432',
      make: 'Maruti Suzuki',
      model: 'Swift',
      odometerKm: 62_140,
      complaints: ['Noise from front brakes', 'Engine oil overdue'],
      lines: [
        { description: 'Brake pad (front)', qty: 2, rateRupees: 1250 },
        { description: 'Engine oil 5W30', qty: 1, rateRupees: 2400 },
        { description: 'Oil filter', qty: 1, rateRupees: 320 },
      ],
      advisorName: 'S. Anand',
      promisedAt: 'evening',
    },
  },
  {
    id: '02-ruled-register-ditto',
    layout: 'ruled-register',
    language: 'en',
    shopName: 'Sri Murugan Auto Works',
    cardNumber: 'JC-1043',
    dateWritten: '14/03',
    exercises: 'Ditto marks repeating the line above, twice.',
    data: {
      customerName: 'Meena Rajan',
      phone: '9788123456',
      registrationWritten: 'TN 22 BZ 3344',
      registrationExpected: 'TN22BZ3344',
      make: 'Toyota',
      model: 'Innova',
      odometerKm: 118_900,
      complaints: ['AC not cooling'],
      lines: [
        { description: 'AC gas refill', qty: 1, rateRupees: 3200 },
        { description: 'AC gas refill', qty: 1, rateRupees: 3200, ditto: true },
        { description: 'Cabin filter', qty: 1, rateRupees: 650 },
      ],
      advisorName: 'K. Prakash',
      promisedAt: 'tomorrow 11 AM',
    },
  },
  {
    id: '03-carbon-pad-faint',
    layout: 'carbon-pad',
    language: 'en',
    shopName: 'Anand Motors',
    cardNumber: 'A-7781',
    dateWritten: '15/03',
    exercises: 'A faint second-copy carbon impression.',
    data: {
      customerName: 'Suresh Babu',
      phone: '9003344556',
      registrationWritten: 'KA-05-MG-7788',
      registrationExpected: 'KA05MG7788',
      make: 'Hyundai',
      model: 'i20',
      odometerKm: 41_320,
      complaints: ['Steering pulls to left'],
      lines: [
        { description: 'Wheel alignment', qty: 1, rateRupees: 900 },
        { description: 'Wheel balancing', qty: 4, rateRupees: 200 },
      ],
      advisorName: 'R. Devi',
      promisedAt: 'same day',
    },
  },
  {
    id: '04-printed-form-mixed',
    layout: 'printed-form',
    language: 'en',
    shopName: 'Precision Car Care',
    cardNumber: 'PCC/2026/0318',
    dateWritten: '16/03/2026',
    exercises: 'A printed form with handwritten values in the boxes.',
    data: {
      customerName: 'Anitha Ramesh',
      phone: '9445566778',
      registrationWritten: 'KL 08 AB 2211',
      registrationExpected: 'KL08AB2211',
      make: 'Tata',
      model: 'Tiago',
      odometerKm: 28_450,
      complaints: ['Puncture rear left', 'General service due'],
      lines: [
        { description: 'Puncture repair', qty: 1, rateRupees: 150 },
        { description: 'Periodic service', qty: 1, rateRupees: 3500 },
        { description: 'Car wash', qty: 1, rateRupees: 400 },
      ],
      advisorName: 'M. Joseph',
      promisedAt: '17/03 morning',
    },
  },
  {
    id: '05-strikethrough-correction',
    layout: 'two-column-pad',
    language: 'en',
    shopName: 'Anand Motors',
    cardNumber: 'A-7794',
    dateWritten: '16/03',
    exercises: 'A struck-through line with its replacement written beside it.',
    data: {
      customerName: 'Vignesh S',
      phone: '9600011223',
      registrationWritten: 'TN 10 CD 9090',
      registrationExpected: 'TN10CD9090',
      make: 'Maruti Suzuki',
      model: 'Ertiga',
      odometerKm: 76_010,
      complaints: ['Clutch slipping'],
      lines: [
        { description: 'Clutch cable', qty: 1, rateRupees: 850, struckThrough: 'Clutch plate' },
        { description: 'Clutch fluid', qty: 1, rateRupees: 420 },
      ],
      advisorName: 'S. Anand',
      promisedAt: 'evening',
    },
  },
  {
    id: '06-rupee-shorthand',
    layout: 'two-column-pad',
    language: 'en',
    shopName: 'Sri Murugan Auto Works',
    cardNumber: 'JC-1051',
    dateWritten: '17/03',
    exercises: 'Rupee shorthand: /- terminators, a comma group and a "k".',
    data: {
      customerName: 'Farhan Ali',
      phone: '9701122334',
      registrationWritten: 'MH 14 GH 5566',
      registrationExpected: 'MH14GH5566',
      make: 'Hyundai',
      model: 'Creta',
      odometerKm: 54_780,
      complaints: ['Suspension noise over bumps'],
      lines: [
        { description: 'Front shock absorber', qty: 2, rateRupees: 4200 },
        { description: 'Suspension bush set', qty: 1, rateRupees: 1500 },
        { description: 'Labour', qty: 1, rateRupees: 2000 },
      ],
      advisorName: 'K. Prakash',
      promisedAt: '19/03',
    },
  },
  {
    id: '07-tamil-items',
    layout: 'ruled-register',
    language: 'ta',
    shopName: 'ஸ்ரீ முருகன் ஆட்டோ வொர்க்ஸ்',
    cardNumber: 'JC-1055',
    dateWritten: '17/03',
    exercises: 'Item names written in Tamil beside an English registration.',
    data: {
      customerName: 'முருகன்',
      phone: '9842233445',
      registrationWritten: 'TN 07 AZ 1122',
      registrationExpected: 'TN07AZ1122',
      make: 'Maruti Suzuki',
      model: 'Swift',
      odometerKm: 89_200,
      complaints: ['பிரேக் சத்தம்'],
      lines: [
        { description: 'ஆயில் மாற்று', qty: 1, rateRupees: 2400 },
        { description: 'பிரேக் பேட்', qty: 2, rateRupees: 1100 },
      ],
      advisorName: 'S. Anand',
      promisedAt: 'மாலை',
    },
  },
  {
    id: '08-hindi-items',
    layout: 'ruled-register',
    language: 'hi',
    shopName: 'वर्मा मोटर्स',
    cardNumber: 'VM-334',
    dateWritten: '18/03',
    exercises: 'Item names written in Hindi beside an English registration.',
    data: {
      customerName: 'राजेश वर्मा',
      phone: '9911223344',
      registrationWritten: 'DL 3C AB 1234',
      registrationExpected: 'DL03CAB1234',
      make: 'Maruti Suzuki',
      model: 'Baleno',
      odometerKm: 33_650,
      complaints: ['क्लच में दिक्कत'],
      lines: [
        { description: 'क्लच प्लेट', qty: 1, rateRupees: 6000 },
        { description: 'इंजन ऑयल', qty: 1, rateRupees: 2200 },
      ],
      advisorName: 'A. Verma',
      promisedAt: 'कल शाम',
    },
  },
  {
    id: '09-bh-series',
    layout: 'printed-form',
    language: 'en',
    shopName: 'Precision Car Care',
    cardNumber: 'PCC/2026/0331',
    dateWritten: '18/03/2026',
    exercises: 'A BH-series registration, which has its own format entirely.',
    data: {
      customerName: 'Nikhil Menon',
      phone: '9820011223',
      registrationWritten: '24 BH 1234 AB',
      registrationExpected: '24BH1234AB',
      make: 'Kia',
      model: 'Seltos',
      odometerKm: 12_800,
      complaints: ['First service due'],
      lines: [
        { description: 'Periodic service', qty: 1, rateRupees: 4800 },
        { description: 'Wiper blade set', qty: 1, rateRupees: 900 },
      ],
      advisorName: 'M. Joseph',
      promisedAt: '19/03 5 PM',
    },
  },
  {
    id: '10-no-prices',
    layout: 'receipt-slip',
    language: 'en',
    shopName: 'Anand Motors',
    cardNumber: 'A-7801',
    dateWritten: '19/03',
    exercises: 'Work listed with no prices at all — nulls, not zeroes.',
    data: {
      customerName: 'Deepa N',
      phone: null,
      registrationWritten: 'TN 01 AA 8899',
      registrationExpected: 'TN01AA8899',
      make: 'Honda',
      model: 'City',
      odometerKm: null,
      complaints: ['Check engine light on', 'Rattle from dashboard'],
      lines: [
        { description: 'Diagnostic scan', qty: 1, rateRupees: null },
        { description: 'Dashboard inspection', qty: 1, rateRupees: null },
      ],
      advisorName: null,
      promisedAt: null,
    },
  },
  {
    id: '11-dense-many-lines',
    layout: 'two-column-pad',
    language: 'en',
    shopName: 'Sri Murugan Auto Works',
    cardNumber: 'JC-1063',
    dateWritten: '19/03',
    exercises: 'A dense card: nine priced lines, tight row spacing.',
    data: {
      customerName: 'Prakash Iyer',
      phone: '9500099887',
      registrationWritten: 'TN 11 XY 6543',
      registrationExpected: 'TN11XY6543',
      make: 'Mahindra',
      model: 'Scorpio',
      odometerKm: 143_770,
      complaints: ['Full service before long trip'],
      lines: [
        { description: 'Engine oil 15W40', qty: 6, rateRupees: 520 },
        { description: 'Oil filter', qty: 1, rateRupees: 480 },
        { description: 'Air filter', qty: 1, rateRupees: 640 },
        { description: 'Fuel filter', qty: 1, rateRupees: 1180 },
        { description: 'Brake pad (front)', qty: 2, rateRupees: 1450 },
        { description: 'Brake fluid', qty: 1, rateRupees: 380 },
        { description: 'Coolant', qty: 2, rateRupees: 410 },
        { description: 'Wheel alignment', qty: 1, rateRupees: 900 },
        { description: 'Labour', qty: 1, rateRupees: 3500 },
      ],
      advisorName: 'K. Prakash',
      promisedAt: '21/03',
    },
  },
  {
    id: '12-slip-minimal',
    layout: 'receipt-slip',
    language: 'en',
    shopName: 'Anand Motors',
    cardNumber: 'A-7815',
    dateWritten: '20/03',
    exercises: 'A narrow slip with almost nothing on it — most fields are null.',
    data: {
      customerName: 'Joseph K',
      phone: '9847766554',
      registrationWritten: 'KL 07 BM 4321',
      registrationExpected: 'KL07BM4321',
      make: null,
      model: null,
      odometerKm: null,
      complaints: ['Battery dead'],
      lines: [{ description: 'Battery 35Ah', qty: 1, rateRupees: 5600 }],
      advisorName: null,
      promisedAt: 'today',
    },
  },
];

/* -------------------------------------------------------------------------- *
 * Answer key
 * -------------------------------------------------------------------------- */

/**
 * The expected value for every field the eval scores, keyed by the same dotted
 * path `draftFields()` uses. Derived from the card data, never written twice.
 *
 * `null` means "the card does not carry this", and an extractor that supplies a
 * value there has invented one — scored wrong, deliberately.
 */
export function expectedFields(fixture: CardFixture): Map<string, string | null> {
  const { data } = fixture;
  const expected = new Map<string, string | null>();

  expected.set('customer.name', data.customerName);
  expected.set('customer.phone', data.phone);
  expected.set('vehicle.registration', data.registrationExpected);
  expected.set('vehicle.make', data.make);
  expected.set('vehicle.model', data.model);
  expected.set('vehicle.odometerKm', data.odometerKm === null ? null : String(data.odometerKm));

  for (const [index, complaint] of data.complaints.entries()) {
    expected.set(`complaints.${index}`, complaint);
  }

  for (const [index, line] of data.lines.entries()) {
    expected.set(`estimateLines.${index}.description`, line.description);
    expected.set(
      `estimateLines.${index}.unitPricePaise`,
      line.rateRupees === null ? null : String(line.rateRupees * 100),
    );
  }

  expected.set('advisorName', data.advisorName);
  expected.set('promisedAt', data.promisedAt);

  return expected;
}

/** Every fixture id, in a stable order. */
export function fixtureIds(): string[] {
  return CARD_FIXTURES.map((fixture) => fixture.id);
}
