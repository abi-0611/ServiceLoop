import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { THEME_SCRIPT } from '@/components/theme-toggle';
import './globals.css';

/**
 * One family, in two widths.
 *
 * IBM Plex was drawn for engineering documentation, and it is the reason this
 * console does not look like every other dashboard: the default choice —
 * Inter, or whatever the component gallery shipped with — is a neutral grotesque
 * that reads as *software*, and this product is read next to a paper job card
 * and a parts invoice. Plex has the slightly mechanical joints and the flat
 * terminals of a technical face, which is the register the content is already
 * in.
 *
 * The mono cut carries every identifier — registration plates, job-card codes,
 * gate passes, money, timestamps. Those are read character by character rather
 * than as words, and a monospace face is what stops a 0 from being read as an O
 * when the decision on the other side of it is whether a car may leave. Using
 * the *same* family for both means the plate and the sentence around it share
 * a skeleton, which a Plex/JetBrains pairing would not.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  title: 'ServiceLoop Console',
  description: 'Job card board, conversations and guardrails for your workshop',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The browser chrome should match the theme the console is actually in,
  // rather than pinning the address bar to light-mode blue at midnight.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f6f2' },
    { media: '(prefers-color-scheme: dark)', color: '#101113' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint. Without it the console
            flashes white at anyone who chose dark — once per navigation. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-background font-sans">{children}</body>
    </html>
  );
}
