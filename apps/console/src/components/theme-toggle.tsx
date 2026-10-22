'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Light / dark / follow-the-system.
 *
 * Three states rather than two on purpose. A workshop's front desk sits under
 * fluorescent light all day and wants light mode pinned; the owner reading the
 * digest at eleven at night wants dark; and most people want neither decision —
 * they want the console to do what the rest of their phone is doing. Collapsing
 * that to a single toggle makes the third group choose twice a day.
 *
 * The preference is written to `localStorage` under `serviceloop-theme` and
 * applied by the inline script in the root layout before first paint, so the
 * console never flashes white at somebody in a dark room.
 */

export const THEME_STORAGE_KEY = 'serviceloop-theme';

type Theme = 'light' | 'dark' | 'system';

const ORDER: readonly Theme[] = ['system', 'light', 'dark'];

const COPY: Readonly<Record<Theme, string>> = {
  system: 'Theme: following your system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function ThemeToggle({ className }: { className?: string }): React.JSX.Element {
  // `system` until mounted: the server has no idea what this browser prefers,
  // and rendering a guess would produce a flicker on hydration.
  const [theme, setTheme] = React.useState<Theme>('system');
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') setTheme(stored);
  }, []);

  const apply = React.useCallback((next: Theme): void => {
    setTheme(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);

    const dark =
      next === 'dark' ||
      (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, []);

  // Following the system means following it as it changes, not as it was at
  // sign-in — the console is left open all day.
  React.useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => {
      document.documentElement.classList.toggle('dark', media.matches);
      document.documentElement.style.colorScheme = media.matches ? 'dark' : 'light';
    };
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [theme]);

  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <button
      type="button"
      aria-label={COPY[theme]}
      title={`${COPY[theme]} — click to change`}
      onClick={() => apply(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme)}
      className={cn(
        'relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground',
        'transition-[color,background-color,transform] duration-200 ease-swift',
        'hover:bg-accent hover:text-foreground active:scale-90',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      <Icon className="size-[17px]" aria-hidden="true" />
      {/* Before mount the icon is a guess, so it is faded rather than wrong. */}
      {!mounted && <span className="absolute inset-0 rounded-md bg-background" />}
    </button>
  );
}

/**
 * The pre-paint theme script.
 *
 * Runs before React and before the first paint. Wrapped in try/catch because a
 * browser with storage disabled must still render the console, just always in
 * light mode.
 */
export const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');var d=s==='dark'||((s===null||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
