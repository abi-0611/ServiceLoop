import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser } from 'playwright';
import { CARD_FIXTURES, type CardFixture } from './fixtures';
import { cardHtmlHash, renderCardHtml } from './render';

/**
 * Turning the HTML fixtures into images, and then into *bad* images.
 *
 * The clean render is the easy case. What separates a useful OCR eval from a
 * flattering one is the degraded set: a photo taken in a workshop is skewed,
 * shadowed by the person holding the phone, noisy from a cheap sensor, and
 * re-compressed by WhatsApp before it ever reaches us. All four are reproduced
 * here deterministically, so a regression is a regression and not a bad roll.
 */

export type Degradation = 'clean' | 'skew' | 'shadow' | 'noise' | 'lowlight';

export const DEGRADATIONS: readonly Degradation[] = [
  'clean',
  'skew',
  'shadow',
  'noise',
  'lowlight',
];

/** Everything except `clean` — the set the lower accuracy gate applies to. */
export const DEGRADED: readonly Degradation[] = DEGRADATIONS.filter(
  (variant) => variant !== 'clean',
);

export interface RenderedCard {
  readonly fixture: CardFixture;
  readonly variant: Degradation;
  readonly path: string;
  readonly bytes: Buffer;
  readonly contentType: string;
}

function seeded(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function renderClean(browser: Browser, fixture: CardFixture): Promise<Buffer> {
  const page = await browser.newPage({
    viewport: { width: fixture.layout === 'receipt-slip' ? 520 : 900, height: 1200 },
    // Fixed scale factor: a different DPR would change every pixel and with it
    // every fixture hash.
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(renderCardHtml(fixture), { waitUntil: 'load' });
    return await page.screenshot({ type: 'png', fullPage: true });
  } finally {
    await page.close();
  }
}

/** Seeded per-pixel sensor noise, multiplied over the page. */
async function addNoise(input: Buffer, seed: string): Promise<Buffer> {
  const image = sharp(input);
  const { width = 0, height = 0 } = await image.metadata();
  if (width === 0 || height === 0) return input;

  const random = seeded(seed);
  const noise = Buffer.allocUnsafe(width * height);
  for (let index = 0; index < noise.length; index += 1) {
    // Centred around white so the overlay darkens speckles rather than
    // washing the whole page out.
    noise[index] = Math.max(0, Math.min(255, Math.round(238 + (random() - 0.5) * 44)));
  }

  return sharp(input)
    .composite([
      {
        input: noise,
        raw: { width, height, channels: 1 },
        blend: 'multiply',
      },
    ])
    .png()
    .toBuffer();
}

/** A soft diagonal shadow, as though someone's hand is over the page. */
async function addShadow(input: Buffer): Promise<Buffer> {
  const image = sharp(input);
  const { width = 0, height = 0 } = await image.metadata();
  if (width === 0 || height === 0) return input;

  const gradient = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Darkest in the top-right corner, fading to untouched at bottom-left.
      const t = (x / width) * 0.65 + (1 - y / height) * 0.35;
      gradient[y * width + x] = Math.round(255 - Math.max(0, t - 0.35) * 150);
    }
  }

  return sharp(input)
    .composite([{ input: gradient, raw: { width, height, channels: 1 }, blend: 'multiply' }])
    .png()
    .toBuffer();
}

async function degrade(clean: Buffer, variant: Degradation, seed: string): Promise<Buffer> {
  switch (variant) {
    case 'clean':
      return clean;
    case 'skew':
      // A phone held at an angle, then re-compressed on the way through chat.
      return sharp(clean)
        .rotate(2.4, { background: '#ffffff' })
        .jpeg({ quality: 78 })
        .toBuffer();
    case 'shadow':
      return sharp(await addShadow(clean)).jpeg({ quality: 82 }).toBuffer();
    case 'noise':
      return sharp(await addNoise(clean, seed)).jpeg({ quality: 70 }).toBuffer();
    case 'lowlight':
      // Dim, slightly out of focus, and heavily re-compressed — the worst
      // realistic case, and the one a shop will actually send at 7pm.
      return sharp(clean)
        .modulate({ brightness: 0.72 })
        .blur(0.9)
        .jpeg({ quality: 55 })
        .toBuffer();
  }
}

export function contentTypeFor(variant: Degradation): string {
  return variant === 'clean' ? 'image/png' : 'image/jpeg';
}

function fileNameFor(fixture: CardFixture, variant: Degradation): string {
  const extension = variant === 'clean' ? 'png' : 'jpg';
  return `${fixture.id}.${variant}.${extension}`;
}

export interface BuildOptions {
  readonly outputDir: string;
  /** Re-render even when a cached image already exists. */
  readonly force?: boolean;
  readonly variants?: readonly Degradation[];
  readonly fixtures?: readonly CardFixture[];
  readonly onProgress?: (message: string) => void;
}

/**
 * Renders the fixture set to disk and returns it.
 *
 * Images are cached: rendering twelve cards through a browser takes seconds,
 * and the eval is run repeatedly while tuning a prompt. The cache key includes
 * the HTML hash, so editing a template invalidates exactly the cards it changed
 * and nothing else.
 */
export async function buildFixtureImages(options: BuildOptions): Promise<RenderedCard[]> {
  const fixtures = options.fixtures ?? CARD_FIXTURES;
  const variants = options.variants ?? DEGRADATIONS;
  const report = options.onProgress ?? (() => {});

  await mkdir(options.outputDir, { recursive: true });

  const manifestPath = join(options.outputDir, 'manifest.json');
  const previous: Record<string, string> = existsSync(manifestPath)
    ? (JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, string>)
    : {};
  const manifest: Record<string, string> = {};

  const results: RenderedCard[] = [];
  let browser: Browser | null = null;

  try {
    for (const fixture of fixtures) {
      const htmlHash = cardHtmlHash(fixture);
      manifest[fixture.id] = htmlHash;

      const stale =
        options.force === true ||
        previous[fixture.id] !== htmlHash ||
        variants.some((variant) => !existsSync(join(options.outputDir, fileNameFor(fixture, variant))));

      let clean: Buffer | null = null;
      if (stale) {
        browser ??= await chromium.launch();
        clean = await renderClean(browser, fixture);
        report(`rendered ${fixture.id}`);
      }

      for (const variant of variants) {
        const path = join(options.outputDir, fileNameFor(fixture, variant));

        if (!stale && existsSync(path)) {
          results.push({
            fixture,
            variant,
            path,
            bytes: await readFile(path),
            contentType: contentTypeFor(variant),
          });
          continue;
        }

        const bytes = await degrade(clean as Buffer, variant, `${fixture.id}:${variant}`);
        await writeFile(path, bytes);
        results.push({ fixture, variant, path, bytes, contentType: contentTypeFor(variant) });
      }
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return results;
  } finally {
    if (browser !== null) await browser.close();
  }
}
