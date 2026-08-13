import type {
  EstimateLineKind,
  JobCardEvent,
  JobCardSource,
  JobCardState,
  Language,
  StaffRole,
} from '@serviceloop/shared';

/**
 * Demo fixtures — "Sri Murugan Auto Works", an independent workshop in Chennai.
 *
 * Ids are fixed (valid UUIDv7 shapes) so demo scripts, Playwright tests and the
 * console can reference known rows, and so re-seeding is deterministic.
 */

export const DEMO_SHOP_ID = '01920000-0000-7000-8000-000000000001';

export const DEMO_SHOP = {
  id: DEMO_SHOP_ID,
  name: 'Sri Murugan Auto Works',
  legalName: 'Sri Murugan Auto Works Pvt Ltd',
  city: 'Chennai',
  addressLine: '14, Nelson Manickam Road, Aminjikarai, Chennai 600029',
  timezone: 'Asia/Kolkata',
  contactPhone: '+914428152200',
  gstNumber: '33AABCS1429B1ZX',
} as const;

export interface StaffFixture {
  readonly id: string;
  readonly role: StaffRole;
  readonly fullName: string;
  readonly phone: string;
  readonly preferredLanguage: Language;
}

export const DEMO_STAFF: readonly StaffFixture[] = [
  {
    id: '01920000-0000-7000-8000-000000000101',
    role: 'OWNER',
    fullName: 'Murugan Selvam',
    phone: '+919840012001',
    preferredLanguage: 'ta',
  },
  {
    id: '01920000-0000-7000-8000-000000000102',
    role: 'ADVISOR',
    fullName: 'Priya Ramesh',
    phone: '+919840012002',
    preferredLanguage: 'ta',
  },
  {
    id: '01920000-0000-7000-8000-000000000103',
    role: 'TECHNICIAN',
    fullName: 'Karthik Manoharan',
    phone: '+919840012003',
    preferredLanguage: 'ta',
  },
  {
    id: '01920000-0000-7000-8000-000000000104',
    role: 'TECHNICIAN',
    fullName: 'Suresh Kumar',
    phone: '+919840012004',
    preferredLanguage: 'hi',
  },
];

export const DEMO_OWNER = DEMO_STAFF[0] as StaffFixture;
export const DEMO_ADVISOR = DEMO_STAFF[1] as StaffFixture;
export const DEMO_TECHNICIAN = DEMO_STAFF[2] as StaffFixture;

export interface CustomerFixture {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly preferredLanguage: Language;
  readonly whatsappOptIn: boolean;
  readonly vehicle: {
    readonly id: string;
    readonly registrationRaw: string;
    readonly make: string;
    readonly model: string;
    readonly modelYear: number;
    readonly fuelType: string;
    readonly colour: string;
    readonly odometerKm: number;
  };
}

/** Twelve customers with the language mix a Chennai workshop actually sees. */
export const DEMO_CUSTOMERS: readonly CustomerFixture[] = [
  {
    id: '01920000-0000-7000-8000-000000000201',
    fullName: 'Anand Krishnan',
    phone: '+919841100001',
    preferredLanguage: 'ta',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000301',
      registrationRaw: 'TN 09 BX 1234',
      make: 'Maruti Suzuki',
      model: 'Swift VDi',
      modelYear: 2019,
      fuelType: 'Diesel',
      colour: 'White',
      odometerKm: 78450,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000202',
    fullName: 'Lakshmi Narayanan',
    phone: '+919841100002',
    preferredLanguage: 'ta',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000302',
      registrationRaw: 'TN 07 CJ 4521',
      make: 'Hyundai',
      model: 'i20 Sportz',
      modelYear: 2021,
      fuelType: 'Petrol',
      colour: 'Silver',
      odometerKm: 41200,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000203',
    fullName: 'Rahul Sharma',
    phone: '+919841100003',
    preferredLanguage: 'hi',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000303',
      registrationRaw: 'TN 10 AM 8890',
      make: 'Honda',
      model: 'City VX',
      modelYear: 2018,
      fuelType: 'Petrol',
      colour: 'Grey',
      odometerKm: 96300,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000204',
    fullName: 'Fatima Beevi',
    phone: '+919841100004',
    preferredLanguage: 'ta',
    whatsappOptIn: false,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000304',
      registrationRaw: 'TN 22 BK 7712',
      make: 'Tata',
      model: 'Nexon XZ+',
      modelYear: 2022,
      fuelType: 'Petrol',
      colour: 'Blue',
      odometerKm: 28900,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000205',
    fullName: 'David Fernandes',
    phone: '+919841100005',
    preferredLanguage: 'en',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000305',
      registrationRaw: 'TN 05 AZ 3344',
      make: 'Toyota',
      model: 'Innova Crysta',
      modelYear: 2017,
      fuelType: 'Diesel',
      colour: 'Pearl White',
      odometerKm: 152400,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000206',
    fullName: 'Meenakshi Sundaram',
    phone: '+919841100006',
    preferredLanguage: 'ta',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000306',
      registrationRaw: 'TN 09 CA 5566',
      make: 'Maruti Suzuki',
      model: 'Baleno Zeta',
      modelYear: 2020,
      fuelType: 'Petrol',
      colour: 'Red',
      odometerKm: 55100,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000207',
    fullName: 'Vikram Reddy',
    phone: '+919841100007',
    preferredLanguage: 'en',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000307',
      registrationRaw: '24 BH 4477 A',
      make: 'Mahindra',
      model: 'XUV700 AX7',
      modelYear: 2024,
      fuelType: 'Diesel',
      colour: 'Black',
      odometerKm: 18700,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000208',
    fullName: 'Kavitha Rajan',
    phone: '+919841100008',
    preferredLanguage: 'ta',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000308',
      registrationRaw: 'TN 11 BF 2299',
      make: 'Renault',
      model: 'Kwid RXT',
      modelYear: 2019,
      fuelType: 'Petrol',
      colour: 'Orange',
      odometerKm: 63800,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000209',
    fullName: 'Imran Qureshi',
    phone: '+919841100009',
    preferredLanguage: 'hi',
    whatsappOptIn: false,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000309',
      registrationRaw: 'TN 04 AH 1188',
      make: 'Volkswagen',
      model: 'Polo Highline',
      modelYear: 2016,
      fuelType: 'Petrol',
      colour: 'Blue',
      odometerKm: 118900,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000210',
    fullName: 'Sridevi Balaji',
    phone: '+919841100010',
    preferredLanguage: 'ta',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000310',
      registrationRaw: 'TN 09 DK 9001',
      make: 'Kia',
      model: 'Seltos HTK+',
      modelYear: 2023,
      fuelType: 'Petrol',
      colour: 'White',
      odometerKm: 22300,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000211',
    fullName: 'Joseph Anthony',
    phone: '+919841100011',
    preferredLanguage: 'en',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000311',
      registrationRaw: 'TN 02 BN 6633',
      make: 'Ford',
      model: 'EcoSport Titanium',
      modelYear: 2018,
      fuelType: 'Diesel',
      colour: 'Grey',
      odometerKm: 88200,
    },
  },
  {
    id: '01920000-0000-7000-8000-000000000212',
    fullName: 'Deepa Venkatesh',
    phone: '+919841100012',
    preferredLanguage: 'ta',
    whatsappOptIn: true,
    vehicle: {
      id: '01920000-0000-7000-8000-000000000312',
      registrationRaw: 'TN 09 EF 7788',
      make: 'Maruti Suzuki',
      model: 'Ertiga VXi',
      modelYear: 2021,
      fuelType: 'Petrol',
      colour: 'Beige',
      odometerKm: 47600,
    },
  },
];

export interface WorkItemFixture {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly technicianNote: string;
  readonly requiresApproval: boolean;
  readonly estimatedMinutes: number;
  readonly lines: ReadonlyArray<{
    readonly kind: EstimateLineKind;
    readonly description: string;
    readonly quantityMilli: number;
    readonly unitPricePaise: number;
  }>;
}

export interface MediaFixture {
  readonly id: string;
  readonly workItemIndex: number;
  readonly caption: string;
}

export interface JobCardFixture {
  readonly id: string;
  readonly code: string;
  readonly customerIndex: number;
  readonly source: JobCardSource;
  readonly complaintText: string;
  readonly targetState: JobCardState;
  /**
   * Ordered script driving the card from DRAFT to `targetState`. Work-item
   * events are interleaved so guards see a realistic history rather than a
   * fabricated one.
   */
  readonly script: ReadonlyArray<
    | { readonly kind: 'card'; readonly event: JobCardEvent }
    | {
        readonly kind: 'items';
        readonly event: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'START' | 'COMPLETE';
      }
    | { readonly kind: 'estimate'; readonly status: 'SENT' | 'ACCEPTED' }
  >;
  readonly workItems: readonly WorkItemFixture[];
  readonly media: readonly MediaFixture[];
}

const toCard = (event: JobCardEvent) => ({ kind: 'card', event }) as const;
const toItems = (event: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'START' | 'COMPLETE') =>
  ({ kind: 'items', event }) as const;
const setEstimate = (status: 'SENT' | 'ACCEPTED') => ({ kind: 'estimate', status }) as const;

/** The path a card walks to reach each state, reused across fixtures. */
const PATHS = {
  DRAFT: [],
  OPEN: [toCard('OPEN_CARD')],
  IN_DIAGNOSIS: [toCard('OPEN_CARD'), toCard('BEGIN_DIAGNOSIS')],
  AWAITING_APPROVAL: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
  ],
  IN_PROGRESS: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
    toItems('APPROVE'),
    setEstimate('ACCEPTED'),
    toCard('APPROVAL_GRANTED'),
    toItems('START'),
  ],
  AWAITING_PARTS: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
    toItems('APPROVE'),
    setEstimate('ACCEPTED'),
    toCard('APPROVAL_GRANTED'),
    toItems('START'),
    toCard('PARTS_AWAITED'),
  ],
  QUALITY_CHECK: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
    toItems('APPROVE'),
    setEstimate('ACCEPTED'),
    toCard('APPROVAL_GRANTED'),
    toItems('START'),
    toItems('COMPLETE'),
    toCard('WORK_COMPLETED'),
  ],
  READY_FOR_DELIVERY: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
    toItems('APPROVE'),
    setEstimate('ACCEPTED'),
    toCard('APPROVAL_GRANTED'),
    toItems('START'),
    toItems('COMPLETE'),
    toCard('WORK_COMPLETED'),
    toCard('QUALITY_PASSED'),
  ],
  AWAITING_PAYMENT: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
    toItems('APPROVE'),
    setEstimate('ACCEPTED'),
    toCard('APPROVAL_GRANTED'),
    toItems('START'),
    toItems('COMPLETE'),
    toCard('WORK_COMPLETED'),
    toCard('QUALITY_PASSED'),
    toCard('PAYMENT_REQUESTED'),
  ],
  DELIVERED: [
    toCard('OPEN_CARD'),
    toCard('BEGIN_DIAGNOSIS'),
    toItems('SUBMIT_FOR_APPROVAL'),
    setEstimate('SENT'),
    toCard('REQUEST_APPROVAL'),
    toItems('APPROVE'),
    setEstimate('ACCEPTED'),
    toCard('APPROVAL_GRANTED'),
    toItems('START'),
    toItems('COMPLETE'),
    toCard('WORK_COMPLETED'),
    toCard('QUALITY_PASSED'),
    toCard('PAYMENT_REQUESTED'),
    toCard('PAYMENT_SETTLED'),
  ],
} as const satisfies Record<string, ReadonlyArray<JobCardFixture['script'][number]>>;

export const DEMO_JOB_CARDS: readonly JobCardFixture[] = [
  {
    id: '01920000-0000-7000-8000-000000000401',
    code: 'JC-2026-0001',
    customerIndex: 0,
    source: 'PAPER_CARD',
    complaintText: 'Front brake noise while braking, steering vibration above 60 kmph',
    targetState: 'AWAITING_APPROVAL',
    script: [...PATHS.AWAITING_APPROVAL],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000501',
        title: 'Front brake pad replacement',
        description: 'Replace front brake pads and clean callipers',
        technicianNote: 'Front pads measured 2.1mm against a 3mm service limit; inner pad scored.',
        requiresApproval: true,
        estimatedMinutes: 60,
        lines: [
          {
            kind: 'PART',
            description: 'Front brake pad set (OEM)',
            quantityMilli: 1000,
            unitPricePaise: 245000,
          },
          {
            kind: 'LABOUR',
            description: 'Brake pad replacement labour',
            quantityMilli: 1000,
            unitPricePaise: 60000,
          },
        ],
      },
      {
        id: '01920000-0000-7000-8000-000000000502',
        title: 'Front wheel balancing',
        description: 'Balance both front wheels',
        technicianNote:
          'Vibration reproduced on road test at 65 kmph; both front wheels out of balance.',
        requiresApproval: true,
        estimatedMinutes: 30,
        lines: [
          {
            kind: 'LABOUR',
            description: 'Wheel balancing (2 wheels)',
            quantityMilli: 2000,
            unitPricePaise: 25000,
          },
        ],
      },
    ],
    media: [
      {
        id: '01920000-0000-7000-8000-000000000601',
        workItemIndex: 0,
        caption: 'Worn front brake pad — 2.1mm remaining',
      },
      {
        id: '01920000-0000-7000-8000-000000000602',
        workItemIndex: 0,
        caption: 'Scored brake disc surface',
      },
    ],
  },
  {
    id: '01920000-0000-7000-8000-000000000402',
    code: 'JC-2026-0002',
    customerIndex: 1,
    source: 'WHATSAPP',
    complaintText: 'AC not cooling properly, cabin smells damp',
    targetState: 'IN_PROGRESS',
    script: [...PATHS.IN_PROGRESS],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000503',
        title: 'AC gas top-up and leak check',
        description: 'Evacuate, leak test, recharge R134a',
        technicianNote:
          'System pressure low at 28 psi; UV dye shows a weep at the condenser fitting.',
        requiresApproval: true,
        estimatedMinutes: 90,
        lines: [
          {
            kind: 'CONSUMABLE',
            description: 'R134a refrigerant',
            quantityMilli: 1000,
            unitPricePaise: 180000,
          },
          {
            kind: 'LABOUR',
            description: 'AC service labour',
            quantityMilli: 1500,
            unitPricePaise: 50000,
          },
        ],
      },
      {
        id: '01920000-0000-7000-8000-000000000504',
        title: 'Cabin filter replacement',
        description: 'Replace cabin air filter',
        technicianNote: 'Cabin filter clogged with leaf debris; source of the damp smell.',
        requiresApproval: true,
        estimatedMinutes: 20,
        lines: [
          {
            kind: 'PART',
            description: 'Cabin air filter',
            quantityMilli: 1000,
            unitPricePaise: 65000,
          },
        ],
      },
    ],
    media: [
      {
        id: '01920000-0000-7000-8000-000000000603',
        workItemIndex: 1,
        caption: 'Clogged cabin filter as removed',
      },
    ],
  },
  {
    id: '01920000-0000-7000-8000-000000000403',
    code: 'JC-2026-0003',
    customerIndex: 2,
    source: 'WALK_IN',
    complaintText: 'Engine oil change due, check engine light on intermittently',
    targetState: 'AWAITING_PARTS',
    script: [...PATHS.AWAITING_PARTS],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000505',
        title: 'Periodic service — 90,000 km',
        description: 'Engine oil, oil filter, air filter, general inspection',
        technicianNote: 'Oil at 96,300 km, last change recorded at 88,000 km. Oil dark and thin.',
        requiresApproval: true,
        estimatedMinutes: 120,
        lines: [
          {
            kind: 'CONSUMABLE',
            description: 'Engine oil 5W-30 (4L)',
            quantityMilli: 4000,
            unitPricePaise: 62000,
          },
          { kind: 'PART', description: 'Oil filter', quantityMilli: 1000, unitPricePaise: 42000 },
          {
            kind: 'LABOUR',
            description: 'Periodic service labour',
            quantityMilli: 2000,
            unitPricePaise: 55000,
          },
        ],
      },
      {
        id: '01920000-0000-7000-8000-000000000506',
        title: 'Oxygen sensor replacement',
        description: 'Replace upstream O2 sensor',
        technicianNote: 'DTC P0135 stored; upstream O2 sensor heater circuit open.',
        requiresApproval: true,
        estimatedMinutes: 45,
        lines: [
          {
            kind: 'PART',
            description: 'Upstream oxygen sensor',
            quantityMilli: 1000,
            unitPricePaise: 480000,
          },
          {
            kind: 'LABOUR',
            description: 'Sensor replacement labour',
            quantityMilli: 1000,
            unitPricePaise: 45000,
          },
        ],
      },
    ],
    media: [
      {
        id: '01920000-0000-7000-8000-000000000604',
        workItemIndex: 1,
        caption: 'Scan tool showing DTC P0135',
      },
    ],
  },
  {
    id: '01920000-0000-7000-8000-000000000404',
    code: 'JC-2026-0004',
    customerIndex: 3,
    source: 'PAPER_CARD',
    complaintText: 'Left rear tyre losing air overnight',
    targetState: 'READY_FOR_DELIVERY',
    script: [...PATHS.READY_FOR_DELIVERY],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000507',
        title: 'Tubeless tyre puncture repair',
        description: 'Locate and plug puncture, re-balance',
        technicianNote: 'Nail found in the left rear tread shoulder; sidewall intact, repairable.',
        requiresApproval: true,
        estimatedMinutes: 40,
        lines: [
          {
            kind: 'LABOUR',
            description: 'Puncture repair and balancing',
            quantityMilli: 1000,
            unitPricePaise: 45000,
          },
        ],
      },
    ],
    media: [
      {
        id: '01920000-0000-7000-8000-000000000605',
        workItemIndex: 0,
        caption: 'Nail embedded in the tread shoulder',
      },
    ],
  },
  {
    id: '01920000-0000-7000-8000-000000000405',
    code: 'JC-2026-0005',
    customerIndex: 4,
    source: 'PHONE',
    complaintText: 'Clutch slipping under load, hard gear shifts',
    targetState: 'AWAITING_PAYMENT',
    script: [...PATHS.AWAITING_PAYMENT],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000508',
        title: 'Clutch assembly replacement',
        description: 'Replace clutch plate, pressure plate and release bearing',
        technicianNote:
          'Clutch plate lining worn to rivets; engine speed flares 800 rpm in 4th under load.',
        requiresApproval: true,
        estimatedMinutes: 300,
        lines: [
          {
            kind: 'PART',
            description: 'Clutch kit (plate, cover, bearing)',
            quantityMilli: 1000,
            unitPricePaise: 1450000,
          },
          {
            kind: 'LABOUR',
            description: 'Clutch replacement labour',
            quantityMilli: 5000,
            unitPricePaise: 65000,
          },
          {
            kind: 'FEE',
            description: 'Gearbox removal handling',
            quantityMilli: 1000,
            unitPricePaise: 120000,
          },
        ],
      },
    ],
    media: [
      {
        id: '01920000-0000-7000-8000-000000000606',
        workItemIndex: 0,
        caption: 'Clutch plate worn to the rivets',
      },
    ],
  },
  {
    id: '01920000-0000-7000-8000-000000000406',
    code: 'JC-2026-0006',
    customerIndex: 5,
    source: 'WHATSAPP',
    complaintText: 'Routine service before a long drive to Coimbatore',
    targetState: 'QUALITY_CHECK',
    script: [...PATHS.QUALITY_CHECK],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000509',
        title: 'Pre-trip inspection and service',
        description: 'Oil change, brake inspection, tyre check, fluid top-up',
        technicianNote: 'All fluids checked; brake pads at 6mm front, 7mm rear — within limits.',
        requiresApproval: true,
        estimatedMinutes: 150,
        lines: [
          {
            kind: 'CONSUMABLE',
            description: 'Engine oil 5W-30 (3.5L)',
            quantityMilli: 3500,
            unitPricePaise: 62000,
          },
          {
            kind: 'LABOUR',
            description: 'Pre-trip inspection labour',
            quantityMilli: 2500,
            unitPricePaise: 55000,
          },
        ],
      },
    ],
    media: [],
  },
  {
    id: '01920000-0000-7000-8000-000000000407',
    code: 'JC-2026-0007',
    customerIndex: 6,
    source: 'CONSOLE',
    complaintText: 'First free service, warranty inspection',
    targetState: 'IN_DIAGNOSIS',
    script: [...PATHS.IN_DIAGNOSIS],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000510',
        title: 'First free service inspection',
        description: 'Manufacturer schedule inspection at 20,000 km',
        technicianNote: 'Inspection in progress; no findings recorded yet.',
        requiresApproval: true,
        estimatedMinutes: 90,
        lines: [
          {
            kind: 'LABOUR',
            description: 'Scheduled inspection labour',
            quantityMilli: 1500,
            unitPricePaise: 55000,
          },
        ],
      },
    ],
    media: [],
  },
  {
    id: '01920000-0000-7000-8000-000000000408',
    code: 'JC-2026-0008',
    customerIndex: 7,
    source: 'PAPER_CARD',
    complaintText: 'Battery weak, car does not start in the morning',
    targetState: 'DELIVERED',
    script: [...PATHS.DELIVERED],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000511',
        title: 'Battery replacement',
        description: 'Replace 12V battery and clean terminals',
        technicianNote: 'Battery load test failed at 8.9V under 200A; terminals heavily corroded.',
        requiresApproval: true,
        estimatedMinutes: 30,
        lines: [
          {
            kind: 'PART',
            description: '12V 35Ah battery',
            quantityMilli: 1000,
            unitPricePaise: 520000,
          },
          {
            kind: 'LABOUR',
            description: 'Fitment and terminal cleaning',
            quantityMilli: 1000,
            unitPricePaise: 30000,
          },
        ],
      },
    ],
    media: [
      {
        id: '01920000-0000-7000-8000-000000000607',
        workItemIndex: 0,
        caption: 'Corroded battery terminals before cleaning',
      },
    ],
  },
  {
    id: '01920000-0000-7000-8000-000000000409',
    code: 'JC-2026-0009',
    customerIndex: 8,
    source: 'WALK_IN',
    complaintText: 'Coolant leak, temperature gauge rising in traffic',
    targetState: 'OPEN',
    script: [...PATHS.OPEN],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000512',
        title: 'Cooling system pressure test',
        description: 'Pressure test the cooling system to locate the leak',
        technicianNote: 'Booked in; pressure test not yet performed.',
        requiresApproval: true,
        estimatedMinutes: 60,
        lines: [
          {
            kind: 'LABOUR',
            description: 'Cooling system diagnosis',
            quantityMilli: 1000,
            unitPricePaise: 50000,
          },
        ],
      },
    ],
    media: [],
  },
  {
    id: '01920000-0000-7000-8000-000000000410',
    code: 'JC-2026-0010',
    customerIndex: 9,
    source: 'PAPER_CARD',
    complaintText: 'Rear wiper not working, boot light stays on',
    targetState: 'DRAFT',
    script: [...PATHS.DRAFT],
    workItems: [
      {
        id: '01920000-0000-7000-8000-000000000513',
        title: 'Rear wiper motor diagnosis',
        description: 'Diagnose rear wiper circuit',
        technicianNote: 'Written up from the photographed paper card; not yet inspected.',
        requiresApproval: true,
        estimatedMinutes: 45,
        lines: [
          {
            kind: 'LABOUR',
            description: 'Electrical diagnosis',
            quantityMilli: 1000,
            unitPricePaise: 50000,
          },
        ],
      },
    ],
    media: [],
  },
];

/**
 * Price-list knowledge document consumed by the phase 3 agent. Stored as a
 * DOCUMENT media asset so it travels through the same StoragePort as every
 * other artefact.
 */
export const DEMO_PRICE_LIST = {
  shop: DEMO_SHOP.name,
  currency: 'INR',
  updatedAt: '2026-01-15',
  note: 'List prices before tax. The agent may never quote below the shop price floor.',
  labourRatePerHourPaise: 55000,
  items: [
    {
      code: 'SVC-PERIODIC-PETROL',
      name: 'Periodic service (petrol hatchback)',
      listPricePaise: 320000,
      taxRateBp: 1800,
    },
    {
      code: 'SVC-PERIODIC-DIESEL',
      name: 'Periodic service (diesel sedan)',
      listPricePaise: 420000,
      taxRateBp: 1800,
    },
    {
      code: 'BRK-PAD-FRONT',
      name: 'Front brake pad set + fitment',
      listPricePaise: 305000,
      taxRateBp: 2800,
    },
    {
      code: 'BRK-DISC-SKIM',
      name: 'Brake disc skimming (per axle)',
      listPricePaise: 140000,
      taxRateBp: 1800,
    },
    { code: 'AC-REGAS', name: 'AC re-gas with leak test', listPricePaise: 255000, taxRateBp: 1800 },
    {
      code: 'AC-CABIN-FILTER',
      name: 'Cabin air filter replacement',
      listPricePaise: 65000,
      taxRateBp: 2800,
    },
    {
      code: 'BAT-35AH',
      name: '12V 35Ah battery + fitment',
      listPricePaise: 550000,
      taxRateBp: 2800,
    },
    {
      code: 'TYR-PUNCTURE',
      name: 'Tubeless puncture repair + balancing',
      listPricePaise: 45000,
      taxRateBp: 1800,
    },
    {
      code: 'WHL-BALANCE',
      name: 'Wheel balancing (per wheel)',
      listPricePaise: 25000,
      taxRateBp: 1800,
    },
    { code: 'WHL-ALIGN', name: 'Four-wheel alignment', listPricePaise: 95000, taxRateBp: 1800 },
    {
      code: 'CLU-KIT-SEDAN',
      name: 'Clutch kit replacement (sedan)',
      listPricePaise: 1635000,
      taxRateBp: 2800,
    },
    {
      code: 'O2-SENSOR',
      name: 'Oxygen sensor replacement',
      listPricePaise: 525000,
      taxRateBp: 2800,
    },
  ],
} as const;
