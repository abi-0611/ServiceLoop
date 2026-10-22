import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Three counter-rotating arcs — @molecule-lab-rushil/orbital-loader.
 *
 * The source drives each ring with a `motion/react` `animate={{rotate}}`,
 * which means importing an animation runtime, and — because `motion` is a
 * client module — turning every server component that wants a spinner into a
 * client component. Three `rotate` keyframes are three lines of CSS, so this is
 * the same picture with no bundle and no boundary: a plain function that a
 * server component can render.
 *
 * Sizes are constrained to the two the console actually needs. `sm` sits inside
 * a button next to its label; `lg` is the page-level wait, and is the only one
 * that gets a message, because a spinner with no words is only honest for an
 * action the user just took and is still looking at.
 */
export function OrbitalLoader({
  size = 'sm',
  message,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  size?: 'sm' | 'lg';
  message?: string;
}): React.JSX.Element {
  const box = size === 'lg' ? 'size-14' : 'size-4';
  const ring = size === 'lg' ? 'border-2' : 'border';

  // Inside a button the label already says "Sending…", so the spinner is pure
  // decoration and announcing it again would read the state twice. Standing on
  // its own, it *is* the announcement.
  const inline = size === 'sm';

  return (
    <div
      {...(inline ? { 'aria-hidden': true } : { role: 'status' })}
      className={cn('flex flex-col items-center justify-center gap-3', className)}
      {...props}
    >
      <div className={cn('relative shrink-0', box)}>
        <span
          className={cn(
            'absolute inset-0 animate-spin rounded-full border-transparent border-t-current opacity-90 [animation-duration:1s]',
            ring,
          )}
        />
        <span
          className={cn(
            'animate-spin-reverse absolute rounded-full border-transparent border-t-current opacity-60',
            ring,
            size === 'lg' ? 'inset-2' : 'inset-[3px]',
          )}
        />
        {/* The third arc only reads as a third arc when there is room for it. */}
        {size === 'lg' && (
          <span
            className={cn(
              'absolute inset-4 animate-spin rounded-full border-transparent border-t-current opacity-40 [animation-duration:0.8s]',
              ring,
            )}
          />
        )}
      </div>
      {message !== undefined && <p className="text-sm text-muted-foreground">{message}</p>}
      {!inline && message === undefined && <span className="sr-only">Working</span>}
    </div>
  );
}
