'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A scroll-linked vertical timeline — adapted from the Aceternity Timeline.
 *
 * The source is a changelog: sticky year headings on the left, screenshots on
 * the right, and a beam down the middle that fills as you scroll. The beam is
 * what makes it worth borrowing for a job-card board. A workshop's states are
 * not parallel buckets, they are a *sequence* — a car arrives at the top and
 * leaves at the bottom — and a row of kanban lanes makes every state look like
 * a peer of every other. A line that fills as you travel down says the one true
 * thing about them that columns cannot.
 *
 * **Why this does not use framer-motion.** The source drives the beam with
 * `useScroll` + `useTransform`, and framer-motion 13 routes `useScroll({target})`
 * through the browser's native ViewTimeline when it can. In this app it chose
 * that path and then never attached: the element ended up with an empty
 * `getAnimations()`, the motion value sat at 0 for the whole page, and nothing
 * was logged. Rather than pin a version to work around it, the scroll maths is
 * eleven lines here — one passive listener, coalesced to a frame, writing a
 * single custom property. It has no bundle cost, it cannot silently stop
 * working when the dependency next changes shape, and the beam is CSS, so the
 * compositor owns it.
 *
 * Three other departures from the source:
 *
 * - **The track is measured with a `ResizeObserver`.** The original reads
 *   `getBoundingClientRect().height` once on mount, which is right for fixed
 *   images and wrong for job cards, whose height depends on how many there are
 *   and how a complaint wraps.
 * - **`prefers-reduced-motion` fills the beam outright.** It is motion tied to
 *   input; somebody who asked for less of it should get the finished state.
 * - **Spacing and colour are an operations screen's.** The source pads each
 *   entry by 160px and runs a purple-to-blue beam. Here the beam is ink, so it
 *   never competes with the twelve state colours that are the only meaningful
 *   colour on this page.
 */

export interface TimelineEntry {
  /** Stable key. */
  readonly id: string;
  /** The sticky heading — a state name. */
  readonly title: React.ReactNode;
  /** Sits under the heading in the sticky column: a count, a chip. */
  readonly meta?: React.ReactNode;
  /** Tailwind classes for the node on the beam, so it can carry state colour. */
  readonly markerClassName?: string;
  readonly content: React.ReactNode;
}

export function Timeline({
  data,
  className,
}: {
  data: readonly TimelineEntry[];
  className?: string;
}): React.JSX.Element {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);

  // Re-measured whenever the track resizes: a card wrapping onto another line,
  // a window resize, or the board arriving after its fetch.
  React.useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null) return;
    const observe = new ResizeObserver(() => setHeight(track.getBoundingClientRect().height));
    observe.observe(track);
    setHeight(track.getBoundingClientRect().height);
    return () => observe.disconnect();
  }, []);

  React.useEffect(() => {
    const track = trackRef.current;
    if (track === null) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      track.style.setProperty('--beam', '1');
      return;
    }

    let frame = 0;

    const measure = (): void => {
      frame = 0;
      const rect = track.getBoundingClientRect();
      const view = window.innerHeight;
      // Empty when the track's top sits 85% down the viewport, full when its
      // bottom reaches 40% — so the line completes as the last stage lands on
      // screen rather than after scrolling past it.
      const from = view * 0.85;
      const to = view * 0.4;
      const travelled = from - rect.top;
      const total = rect.height + (from - to);
      const progress = total <= 0 ? 1 : Math.min(1, Math.max(0, travelled / total));
      track.style.setProperty('--beam', progress.toFixed(4));
    };

    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [height]);

  return (
    <div className={cn('w-full', className)}>
      <div ref={trackRef} className="relative [--beam:0]">
        {/* The rail. Masked at both ends so the line never appears to start or
            stop at an arbitrary pixel. */}
        <div
          aria-hidden="true"
          className="absolute left-[11px] top-0 w-px overflow-hidden bg-gradient-to-b from-transparent via-border to-transparent [mask-image:linear-gradient(to_bottom,transparent,black_6%,black_94%,transparent)] sm:left-[15px]"
          style={{ height: height === 0 ? '100%' : `${height}px` }}
        >
          <div
            className="absolute inset-x-0 top-0 w-px rounded-full bg-gradient-to-b from-primary via-primary/70 to-primary/20"
            style={{
              height: 'calc(var(--beam) * 100%)',
              opacity: 'min(1, calc(var(--beam) * 12))',
            }}
          />
        </div>

        {data.map((entry) => (
          <section key={entry.id} className="flex justify-start gap-4 pb-10 pt-2 sm:gap-8 md:pb-14">
            {/* The sticky heading column. Below `md` it collapses to the node
                alone and the state name moves inline above the cards — a phone
                has no width to spend on a permanent left margin. */}
            <div className="sticky top-20 z-20 flex h-fit shrink-0 items-start self-start md:w-52 lg:w-64">
              <span
                aria-hidden="true"
                className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background sm:size-8"
              >
                <span
                  className={cn(
                    'size-2.5 rounded-full bg-gradient-to-b sm:size-3',
                    entry.markerClassName,
                  )}
                />
              </span>
              <span className="ml-4 hidden min-w-0 md:block">
                <span className="block truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em]">
                  {entry.title}
                </span>
                {entry.meta !== undefined && (
                  <span className="mt-1 block text-xs text-muted-foreground">{entry.meta}</span>
                )}
              </span>
            </div>

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="mb-3 flex flex-wrap items-center gap-2 md:hidden">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em]">
                  {entry.title}
                </span>
                {entry.meta !== undefined && (
                  <span className="text-xs text-muted-foreground">{entry.meta}</span>
                )}
              </div>
              {entry.content}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
