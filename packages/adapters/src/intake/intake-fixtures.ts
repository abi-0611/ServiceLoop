import type { Language } from '@serviceloop/shared';

/**
 * The forwarded-message corpus (phase 2.7).
 *
 * Ten messages of the kind an advisor actually forwards, across English,
 * Tamil-English and Hindi-English — in both native script and the romanised
 * form most people type on a phone. They are the acceptance fixtures for the
 * text and voice intake paths, and they double as the sandbox simulator's
 * quick-send menu so a developer can reproduce any of them in one click.
 *
 * `expect` states only what the message actually asserts. Where a message says
 * nothing about a field, the fixture says nothing either — a corpus that
 * demanded a value the text never carried would be testing the parser's
 * imagination.
 */

export interface IntakeMessageFixture {
  readonly id: string;
  readonly register: 'en' | 'ta-en' | 'hi-en' | 'ta' | 'hi';
  readonly text: string;
  readonly expect: {
    readonly language: Language;
    readonly customerName?: string;
    readonly registration?: string;
    readonly model?: string;
    readonly make?: string;
    readonly phone?: string;
    /** Substrings that must each appear in some complaint line. */
    readonly complaints: readonly string[];
    readonly totalQuotedPaise?: number;
    readonly promisedAt?: string;
  };
}

export const INTAKE_MESSAGE_FIXTURES: readonly IntakeMessageFixture[] = [
  {
    id: 'en-swift-partial-plate',
    register: 'en',
    text: 'Ravi anna Swift MH12 brake pad + oil change 3500 evening delivery',
    expect: {
      language: 'en',
      customerName: 'Ravi',
      // Only a partial plate was sent. Recording it as written is right;
      // padding it into a full registration would invent a vehicle.
      registration: 'MH12',
      model: 'Swift',
      make: 'Maruti Suzuki',
      complaints: ['Brake pad', 'oil'],
      totalQuotedPaise: 350_000,
      promisedAt: 'this evening',
    },
  },
  {
    id: 'ta-en-alto-brake-noise',
    register: 'ta-en',
    text: 'Kumar sir TN09BX4432 Alto brake sound irukku oil change um pannunga 4500 naalaikku',
    expect: {
      language: 'ta',
      customerName: 'Kumar',
      registration: 'TN09BX4432',
      model: 'Alto',
      complaints: ['Brake', 'oil'],
      totalQuotedPaise: 450_000,
      promisedAt: 'tomorrow',
    },
  },
  {
    id: 'hi-en-baleno-clutch',
    register: 'hi-en',
    text: 'Sharma ji ki Baleno DL3CAB1234 clutch problem hai 6000 tak kal shaam',
    expect: {
      language: 'hi',
      customerName: 'Sharma',
      registration: 'DL03CAB1234',
      model: 'Baleno',
      make: 'Maruti Suzuki',
      complaints: ['Clutch'],
      totalQuotedPaise: 600_000,
      promisedAt: 'tomorrow evening',
    },
  },
  {
    id: 'en-i20-ac-alignment',
    register: 'en',
    text: 'Priya madam Hyundai i20 KA05MG7788 AC not cooling and wheel alignment 2800 today 5pm',
    expect: {
      language: 'en',
      customerName: 'Priya',
      registration: 'KA05MG7788',
      model: 'I20',
      make: 'Hyundai',
      complaints: ['AC', 'alignment'],
      totalQuotedPaise: 280_000,
      promisedAt: 'today 5pm',
    },
  },
  {
    id: 'ta-native-oil-change',
    register: 'ta',
    text: 'முருகன் anna TN07AZ1122 Swift ஆயில் மாற்று 2400 மாலை',
    expect: {
      language: 'ta',
      customerName: 'முருகன்',
      registration: 'TN07AZ1122',
      model: 'Swift',
      complaints: ['oil'],
      totalQuotedPaise: 240_000,
      promisedAt: 'this evening',
    },
  },
  {
    id: 'hi-native-brake-pad',
    register: 'hi',
    text: 'वर्मा जी की Creta MH14GH5566 ब्रेक पैड बदलना है 7200 कल',
    expect: {
      language: 'hi',
      customerName: 'वर्मा',
      registration: 'MH14GH5566',
      model: 'Creta',
      make: 'Hyundai',
      complaints: ['Brake pad'],
      totalQuotedPaise: 720_000,
      promisedAt: 'tomorrow',
    },
  },
  {
    id: 'ta-en-ertiga-battery',
    register: 'ta-en',
    text: 'Selvam thambi vandi TN10CD9090 Ertiga battery replace pannunga 5600 inniku',
    expect: {
      language: 'ta',
      customerName: 'Selvam',
      registration: 'TN10CD9090',
      model: 'Ertiga',
      complaints: ['Battery'],
      totalQuotedPaise: 560_000,
      promisedAt: 'today',
    },
  },
  {
    id: 'hi-en-nexon-suspension',
    register: 'hi-en',
    text: 'Rohit bhai gaadi UP32XY4321 Nexon suspension aur wheel balancing karo 9800 parso',
    expect: {
      language: 'hi',
      customerName: 'Rohit',
      registration: 'UP32XY4321',
      model: 'Nexon',
      make: 'Tata',
      complaints: ['Suspension', 'balancing'],
      totalQuotedPaise: 980_000,
      promisedAt: 'day after tomorrow',
    },
  },
  {
    id: 'en-tiago-with-phone',
    register: 'en',
    text: 'Anitha madam 9840012345 Tata Tiago KL08AB2211 puncture repair and car wash 900 morning',
    expect: {
      language: 'en',
      customerName: 'Anitha',
      registration: 'KL08AB2211',
      model: 'Tiago',
      make: 'Tata',
      phone: '+919840012345',
      complaints: ['Puncture', 'wash'],
      totalQuotedPaise: 90_000,
      promisedAt: 'this morning',
    },
  },
  {
    id: 'ta-en-innova-ac-denting',
    register: 'ta-en',
    text: 'Ganesh anna TN22BZ3344 Innova AC service um denting um 12000 naalaikku kaalai',
    expect: {
      language: 'ta',
      customerName: 'Ganesh',
      registration: 'TN22BZ3344',
      model: 'Innova',
      make: 'Toyota',
      complaints: ['AC', 'Denting'],
      totalQuotedPaise: 1_200_000,
      promisedAt: 'tomorrow morning',
    },
  },
];
