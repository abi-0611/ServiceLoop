import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * shadcn/ui-compatible token set. Advisors work on phones on a shop floor, so
 * the palette is high-contrast and the base type scale is generous.
 *
 * Everything below is expressed as an HSL *triplet* in a CSS variable rather
 * than a literal colour, because the console ships two themes and a token that
 * only exists in one of them is a bug waiting for the first advisor who works
 * a late shift with dark mode on.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          soft: 'hsl(var(--primary-soft))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        /** Surfaces above the page but below a dialog — nav rail, sticky bars. */
        surface: { DEFAULT: 'hsl(var(--surface))', foreground: 'hsl(var(--surface-foreground))' },
        /** The second brand hue. Used for emphasis, never for state. */
        brand: { DEFAULT: 'hsl(var(--brand))', foreground: 'hsl(var(--brand-foreground))' },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 10px)',
      },
      boxShadow: {
        // Tight contact shadows, not the wide soft haze a card gallery uses.
        // A control on this screen should look like a printed thing lying on a
        // desk — a millimetre off the paper — rather than like a card floating
        // in an infinite grey void.
        xs: '0 1px 1px 0 hsl(var(--shadow-color) / 0.05)',
        sm: '0 1px 2px -1px hsl(var(--shadow-color) / 0.12), 0 1px 1px 0 hsl(var(--shadow-color) / 0.05)',
        md: '0 2px 3px -2px hsl(var(--shadow-color) / 0.13), 0 4px 10px -4px hsl(var(--shadow-color) / 0.09)',
        lg: '0 3px 6px -3px hsl(var(--shadow-color) / 0.15), 0 10px 22px -8px hsl(var(--shadow-color) / 0.13)',
        xl: '0 6px 12px -6px hsl(var(--shadow-color) / 0.18), 0 20px 40px -12px hsl(var(--shadow-color) / 0.18)',
        'inner-top': 'inset 0 1px 0 0 hsl(0 0% 100% / 0.06)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translate3d(0, 10px, 0)' },
          to: { opacity: '1', transform: 'none' },
        },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'none' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translate3d(16px, 0, 0)' },
          to: { opacity: '1', transform: 'none' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(2.2)', opacity: '0' },
          '100%': { transform: 'scale(2.2)', opacity: '0' },
        },
        // The needle a workshop instrument would have: a short settle, not a
        // loop. Used once, on the sign-in mark.
        'sweep-in': {
          from: { transform: 'rotate(-140deg)', opacity: '0' },
          '70%': { transform: 'rotate(8deg)', opacity: '1' },
          to: { transform: 'none', opacity: '1' },
        },
        // The counter-rotating ring of the orbital loader.
        'spin-reverse': {
          to: { transform: 'rotate(-360deg)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.4s ease-out both',
        'scale-in': 'scale-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
        'slide-in-right': 'slide-in-right 0.4s cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.8s infinite',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'sweep-in': 'sweep-in 0.9s cubic-bezier(0.22, 1, 0.36, 1) both',
        'spin-reverse': 'spin-reverse 1.5s linear infinite',
      },
      transitionTimingFunction: {
        // The one easing curve the console uses for anything that moves under
        // a finger: fast out of the gate, settled without a bounce.
        swift: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      backgroundImage: {
        'grid-faint':
          'linear-gradient(to right, hsl(var(--border) / 0.5) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border) / 0.5) 1px, transparent 1px)',
      },
    },
  },
  plugins: [animate],
};

export default config;
