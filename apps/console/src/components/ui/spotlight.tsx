'use client';

import * as React from 'react';

/**
 * The pointer-following spotlight, applied to a whole region rather than to
 * each card.
 *
 * The naive version of this effect puts a `mousemove` listener on every card,
 * which on the job-card board means one listener and one style write per card
 * per frame. This binds **once** per grid: the handler finds the nearest
 * `[data-spotlight]` under the pointer and writes `--mx`/`--my` on that element
 * only, so a board with eighty cards costs exactly as much as a board with one.
 *
 * The write is deliberately a raw `style.setProperty` inside a
 * `requestAnimationFrame` rather than React state — re-rendering a server
 * component tree sixty times a second to move a gradient would be absurd.
 */
export function SpotlightArea({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;

    // Someone who has asked for less motion is not asking for a light that
    // chases their cursor either.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;

    // Coarse pointers have no hover, so the effect would only ever fire on tap.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let frame = 0;
    let pending: { target: HTMLElement; x: number; y: number } | null = null;

    const flush = (): void => {
      frame = 0;
      if (pending === null) return;
      pending.target.style.setProperty('--mx', `${pending.x}px`);
      pending.target.style.setProperty('--my', `${pending.y}px`);
      pending = null;
    };

    const onMove = (event: PointerEvent): void => {
      const node = event.target;
      if (!(node instanceof Element)) return;
      const target = node.closest<HTMLElement>('[data-spotlight]');
      if (target === null) return;

      const rect = target.getBoundingClientRect();
      pending = { target, x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (frame === 0) frame = requestAnimationFrame(flush);
    };

    root.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      root.removeEventListener('pointermove', onMove);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={rootRef} className={className} {...props}>
      {children}
    </div>
  );
}
