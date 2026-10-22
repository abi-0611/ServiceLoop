'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The presentational half of the sign-in screen — adapted from the sign-in-flo
 * component.
 *
 * Only the parts that survive contact with this product are here. The source
 * ships an email-and-password form with a sign-up toggle, a "remember me"
 * checkbox, a "forgot password?" link and GitHub / Twitter / LinkedIn buttons.
 * ServiceLoop has none of those: staff are registered by their workshop, there
 * is no password to forget and no OAuth to continue with, and a sign-in screen
 * whose buttons do nothing is worse than a plain one. What is worth keeping is
 * the *field* — a label that lifts out of the way as you type, an icon that
 * takes the accent on focus, and a wash that follows the pointer — and the
 * particles behind it. Those work for any credential, including a six-digit
 * code.
 *
 * The page composes these with the real OTP calls; this file holds no state
 * about authentication and no network code.
 */

/* --------------------------------------------------------------------------
   Field
   -------------------------------------------------------------------------- */

export interface AnimatedFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'placeholder'> {
  /** Wired to the label's `htmlFor`. Required — see the note below. */
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Extra classes for the `<input>` itself, not the shell. */
  inputClassName?: string;
}

export const AnimatedField = React.forwardRef<HTMLInputElement, AnimatedFieldProps>(
  ({ id, label, icon, className, inputClassName, value, onFocus, onBlur, ...props }, ref) => {
    const [focused, setFocused] = React.useState(false);
    const shellRef = React.useRef<HTMLDivElement>(null);

    // The source keeps the pointer position in React state and re-renders the
    // field on every mousemove. This writes two custom properties straight to
    // the node inside one animation frame instead: same wash, no render.
    const frame = React.useRef(0);
    const point = React.useRef({ x: 0, y: 0 });

    const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const shell = shellRef.current;
      if (shell === null) return;
      const rect = shell.getBoundingClientRect();
      point.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (frame.current !== 0) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        shell.style.setProperty('--fx', `${point.current.x}px`);
        shell.style.setProperty('--fy', `${point.current.y}px`);
      });
    }, []);

    React.useEffect(
      () => () => {
        if (frame.current !== 0) cancelAnimationFrame(frame.current);
      },
      [],
    );

    const lifted = focused || (typeof value === 'string' && value.length > 0);

    return (
      <div className={cn('group relative', className)}>
        <div
          ref={shellRef}
          onPointerMove={onPointerMove}
          className={cn(
            'relative overflow-hidden rounded-md border border-input bg-background shadow-xs',
            'transition-[border-color,box-shadow] duration-300 ease-swift',
            'hover:border-muted-foreground/40',
            'focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25',
            // The pointer wash. Achromatic and faint, rather than the source's
            // hardcoded blue — this console spends its colour on job-card state.
            'before:pointer-events-none before:absolute before:inset-0 before:opacity-0',
            'before:transition-opacity before:duration-300 hover:before:opacity-100',
            'before:[background:radial-gradient(200px_circle_at_var(--fx,50%)_var(--fy,50%),hsl(var(--foreground)/0.06),transparent_70%)]',
          )}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-muted-foreground transition-colors duration-200 group-focus-within:text-primary [&_svg]:size-[18px]"
          >
            {icon}
          </span>

          {/* `htmlFor`/`id` rather than the source's bare `<label>`. A floating
              label that is not associated with its input is invisible to a
              screen reader and to `getByLabel` — the control announces as an
              unlabelled textbox, which on a sign-in screen means "type your
              what?". */}
          <label
            htmlFor={id}
            className={cn(
              'pointer-events-none absolute left-11 z-10 transition-all duration-200 ease-swift',
              lifted
                ? 'top-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-primary'
                : 'top-1/2 -translate-y-1/2 text-sm text-muted-foreground',
            )}
          >
            {label}
          </label>

          <input
            ref={ref}
            id={id}
            value={value}
            onFocus={(event) => {
              setFocused(true);
              onFocus?.(event);
            }}
            onBlur={(event) => {
              setFocused(false);
              onBlur?.(event);
            }}
            className={cn(
              'relative z-10 h-14 w-full bg-transparent pb-1.5 pl-11 pr-4 pt-5 text-base text-foreground',
              'focus:outline-none',
              inputClassName,
            )}
            {...props}
          />
        </div>
      </div>
    );
  },
);
AnimatedField.displayName = 'AnimatedField';

/* --------------------------------------------------------------------------
   Particles
   -------------------------------------------------------------------------- */

/**
 * A drifting particle field on a canvas.
 *
 * Four corrections to the source, all of them things that would have bitten in
 * production:
 *
 * - **The animation loop is cancelled.** The original starts a
 *   `requestAnimationFrame` loop and returns a cleanup that only removes the
 *   resize listener, so the loop keeps running for the life of the tab after
 *   the component unmounts — and a second mount starts a second loop.
 * - **It sizes to the canvas, not the window.** `canvas.width =
 *   window.innerWidth` is wrong for an element that is `inset-0` inside a
 *   card-sized parent, and it ignores `devicePixelRatio`, so the dots render
 *   blurry on every retina screen.
 * - **It respects `prefers-reduced-motion`.** Drifting dots are ambient motion
 *   with no informational content; someone who asked for less of it gets none.
 * - **The colour comes from the theme.** The source hardcodes
 *   `rgba(59, 130, 246, …)`, which is invisible on this console's light paper
 *   and belongs to no part of its palette. This reads its own computed colour,
 *   so it inherits whatever `text-*` class it is given and works in both
 *   themes.
 */
export function ParticleField({ className }: { className?: string }): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const colour = window.getComputedStyle(canvas).color;
    let frame = 0;

    interface Dot {
      x: number;
      y: number;
      size: number;
      dx: number;
      dy: number;
      alpha: number;
    }

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;

    const seed = (): void => {
      // Density rather than a fixed 50, so a phone does not get the same
      // number of dots as a desktop and look like static.
      const count = Math.min(70, Math.round((width * height) / 18_000));
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 1.6 + 0.6,
        dx: (Math.random() - 0.5) * 0.35,
        dy: (Math.random() - 0.5) * 0.35,
        alpha: Math.random() * 0.28 + 0.04,
      }));
    };

    const resize = (): void => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      seed();
    };

    const draw = (): void => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = colour;
      for (const dot of dots) {
        dot.x += dot.dx;
        dot.y += dot.dy;
        if (dot.x > width) dot.x = 0;
        if (dot.x < 0) dot.x = width;
        if (dot.y > height) dot.y = 0;
        if (dot.y < 0) dot.y = height;

        context.globalAlpha = dot.alpha;
        context.beginPath();
        context.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 h-full w-full', className)}
    />
  );
}
