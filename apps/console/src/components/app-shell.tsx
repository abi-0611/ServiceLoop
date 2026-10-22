'use client';

import {
  Activity,
  BarChart3,
  FlaskConical,
  Inbox,
  LayoutGrid,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Phone,
  QrCode,
  ShieldCheck,
  SlidersHorizontal,
  FileText,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

/**
 * The console's frame.
 *
 * Two decisions are worth the words.
 *
 * **One nav, two shapes.** The links exist exactly once in the DOM: on a large
 * screen the element is a static rail, and below `lg` the same element is a
 * slide-over panel. Rendering a desktop nav *and* a mobile nav would put every
 * destination in the document twice — a screen reader would announce the
 * console's navigation twice over, and every `getByRole('link')` in the
 * behavioural suite would become ambiguous.
 *
 * **The indicator is one element, not one per item.** A single bar slides to
 * whichever item is active and a single wash follows the pointer, both animated
 * with `transform` alone. The alternative — an `::after` on twelve items, each
 * transitioning its own background — is twelve times the paint for an effect
 * that reads as less deliberate, because nothing appears to *travel*.
 */

/**
 * Text that belongs to the expanded rail.
 *
 * Below `lg` the rail is a drawer and every label is simply visible. From `lg`
 * up it is an icon rail, and the words fade and slide in with the width. They
 * are made `pointer-events-none` while hidden so a label that is technically
 * still in the layout cannot swallow a click meant for the icon beside it, and
 * they are never `display: none` — a hidden label still has to be readable by a
 * screen reader, which navigates the nav by its link text.
 */
const LABEL = [
  'whitespace-nowrap transition-[opacity,transform] duration-200 ease-swift',
  'lg:pointer-events-none lg:-translate-x-1 lg:opacity-0',
  'lg:group-hover/rail:pointer-events-auto lg:group-hover/rail:translate-x-0 lg:group-hover/rail:opacity-100',
  'lg:group-focus-within/rail:pointer-events-auto lg:group-focus-within/rail:translate-x-0 lg:group-focus-within/rail:opacity-100',
].join(' ');

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly demoOnly?: boolean;
}

interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Workshop',
    items: [
      { href: '/board', label: 'Job cards', icon: LayoutGrid },
      { href: '/conversations', label: 'Conversations', icon: MessageSquare },
      { href: '/review', label: 'Review queue', icon: ShieldCheck },
      { href: '/status', label: 'Status signals', icon: Activity },
      { href: '/intake', label: 'Intake', icon: Inbox },
      { href: '/gate', label: 'Gate', icon: QrCode },
    ],
  },
  {
    label: 'Insight',
    items: [{ href: '/analytics', label: 'Analytics', icon: BarChart3 }],
  },
  {
    label: 'Demo',
    items: [
      { href: '/sandbox', label: 'Sandbox', icon: FlaskConical, demoOnly: true },
      { href: '/softphone', label: 'Softphone', icon: Phone, demoOnly: true },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings/guardrails', label: 'Guardrails', icon: SlidersHorizontal },
      { href: '/settings/templates', label: 'Templates', icon: FileText },
      { href: '/settings/privacy', label: 'Privacy', icon: Lock },
    ],
  },
];

export function AppShell({
  children,
  shopSwitcher,
  staffName,
  role,
  shopName,
  demoMode,
}: {
  children: React.ReactNode;
  shopSwitcher: React.ReactNode;
  staffName: string;
  role: string;
  shopName: string;
  demoMode: boolean;
}): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  const groups = React.useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.demoOnly !== true || demoMode),
      })).filter((group) => group.items.length > 0),
    [demoMode],
  );

  // A tap on a destination should close the panel it was tapped in; a tap on
  // the destination you are already on should too.
  React.useEffect(() => setOpen(false), [pathname]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const active = activeHref(
    pathname,
    groups.flatMap((group) => group.items.map((item) => item.href)),
  );

  return (
    // Padding rather than a grid column, because the rail is `fixed` — it
    // overlays the page when it expands so that hovering it never reflows a
    // board of eighty cards, and an out-of-flow element cannot hold a grid
    // track open. `lg:pl-[68px]` reserves exactly the collapsed width.
    <div className="min-h-dvh">
      {/* Scrim. Present only while the panel is, so it never eats a tap. */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={cn(
          'fixed inset-0 z-40 bg-background/70 backdrop-blur-sm transition-opacity duration-300 ease-swift lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        id="console-navigation"
        className={cn(
          'group/rail fixed inset-y-0 left-0 z-50 flex w-[268px] max-w-[85vw] flex-col overflow-hidden border-r border-border bg-surface',
          'transition-[transform,width,box-shadow] duration-300 ease-swift will-change-transform',
          // Collapsed to an icon rail on a desk, opening under the pointer or
          // under keyboard focus. 68px is the smallest width that still centres
          // an 18px icon inside a 44px touch target.
          'lg:z-40 lg:w-[68px] lg:max-w-none lg:translate-x-0',
          'lg:hover:w-[264px] lg:hover:shadow-xl lg:focus-within:w-[264px] lg:focus-within:shadow-xl',
          open ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-[25px] lg:px-[25px]">
          <Link
            href="/board"
            className="-ml-[1px] flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <LoopMark />
            <span className={cn(LABEL, 'text-[15px] font-semibold tracking-tight')}>
              ServiceLoop
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="ml-auto inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
          >
            <X className="size-[18px]" aria-hidden="true" />
          </button>
        </div>

        <NavList groups={groups} active={active} />

        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-md px-[9px] py-2">
            <span
              className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary ring-1 ring-inset ring-primary/15"
              aria-hidden="true"
            >
              {initials(staffName)}
            </span>
            <span className={cn(LABEL, 'min-w-0 flex-1')}>
              <span className="block truncate text-sm font-medium">{staffName}</span>
              <span className="block truncate text-xs capitalize text-muted-foreground">
                {role.toLowerCase()} · {shopName}
              </span>
            </span>
            <form
              action="/api/session/logout"
              method="post"
              className={cn(LABEL, 'shrink-0')}
            >
              <button
                type="submit"
                title="Sign out"
                className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-200 ease-swift hover:bg-destructive/10 hover:text-destructive active:scale-90"
              >
                <LogOut className="size-[17px]" aria-hidden="true" />
                <span className="sr-only">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col lg:pl-[68px]">
        <header className="glass sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="console-navigation"
            className="-ml-1 inline-flex size-10 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-200 ease-swift hover:bg-accent hover:text-foreground active:scale-90 lg:hidden"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>

          <Link href="/board" className="flex items-center gap-2 lg:hidden">
            <LoopMark />
            <span className="text-sm font-semibold tracking-tight">ServiceLoop</span>
          </Link>

          {/* The control cluster, grouped as a dock rather than as three loose
              buttons. The magnification the source dock is known for is left
              out on purpose — icons that grow as the pointer passes are a
              delight on a portfolio and a moving target on a shop floor — but
              the grouping is kept, because it says "these three are the
              console's own controls, not this screen's". */}
          <div className="ml-auto flex items-center gap-1 rounded-full border border-border bg-card/70 p-1 shadow-xs backdrop-blur">
            {demoMode && (
              <span className="ml-1.5 mr-0.5 hidden items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-brand sm:inline-flex">
                <span className="relative flex size-1.5">
                  <span className="ping-dot absolute inset-0 rounded-full opacity-70" />
                  <span className="relative size-1.5 rounded-full bg-current" />
                </span>
                Demo
              </span>
            )}
            {shopSwitcher}
            <ThemeToggle />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

/**
 * The nav list, its active bar and its hover wash.
 *
 * Both indicators are measured from the DOM rather than computed from an index,
 * because the groups are filtered by `DEMO_MODE` and the item heights are set
 * by the type scale — arithmetic over an assumed row height is the kind of
 * thing that survives review and breaks the first time somebody changes a
 * padding value.
 */
function NavList({
  groups,
  active,
}: {
  groups: readonly NavGroup[];
  active: string | null;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [bar, setBar] = React.useState<{ top: number; height: number } | null>(null);
  const [wash, setWash] = React.useState<{ top: number; height: number } | null>(null);

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const el = list.querySelector<HTMLElement>('[data-active="true"]');
    if (el === null) {
      setBar(null);
      return;
    }
    setBar({ top: el.offsetTop, height: el.offsetHeight });
  }, [active, groups]);

  return (
    <nav
      aria-label="Console sections"
      className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-4"
    >
      <div ref={listRef} className="relative" onMouseLeave={() => setWash(null)}>
        {/* The pointer wash, behind everything. */}
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 z-0 rounded-lg bg-accent/60',
            'transition-[transform,height,opacity] duration-300 ease-swift',
            wash === null ? 'opacity-0' : 'opacity-100',
          )}
          style={{
            transform: `translate3d(0, ${wash?.top ?? 0}px, 0)`,
            height: wash?.height ?? 0,
          }}
        />

        {/* The active bar: a 3px stripe that travels between destinations. */}
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute left-0 z-20 w-[3px] rounded-r-full bg-primary',
            'transition-[transform,height,opacity] duration-300 ease-swift',
            bar === null ? 'opacity-0' : 'opacity-100',
          )}
          style={{
            transform: `translate3d(0, ${(bar?.top ?? 0) + 8}px, 0)`,
            height: Math.max((bar?.height ?? 0) - 16, 0),
          }}
        />

        {groups.map((group) => (
          <div key={group.label} className="mb-1 last:mb-0">
            {/* Collapsed, this keeps its height and loses its words — the gap
                between icon clusters becomes the group separator, which is one
                fewer element than drawing a rule and hiding it again. */}
            <p
              className={cn(
                LABEL,
                'px-3 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70',
              )}
            >
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = active === item.href;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      data-active={isActive}
                      title={item.label}
                      aria-current={isActive ? 'page' : undefined}
                      onMouseEnter={(event) =>
                        setWash({
                          top: event.currentTarget.offsetTop,
                          height: event.currentTarget.offsetHeight,
                        })
                      }
                      onFocus={(event) =>
                        setWash({
                          top: event.currentTarget.offsetTop,
                          height: event.currentTarget.offsetHeight,
                        })
                      }
                      className={cn(
                        'relative z-10 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium',
                        'transition-[color,transform] duration-200 ease-swift',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:translate-x-0.5 hover:text-foreground',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-[18px] shrink-0 transition-colors duration-200',
                          isActive ? 'text-primary' : 'text-muted-foreground/80',
                        )}
                        aria-hidden="true"
                      />
                      <span className={cn(LABEL, 'truncate')}>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/**
 * Which nav entry owns this URL.
 *
 * Longest prefix wins, so `/settings/guardrails` highlights Guardrails rather
 * than also lighting up anything that happens to start with `/settings`, and
 * `/board/<id>` keeps Job cards lit while a drawer is open.
 */
function activeHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (pathname !== href && !pathname.startsWith(`${href}/`)) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * The mark: a loop that does not quite close.
 *
 * The product is a loop — intake, approval, status, delivery, back round — and
 * the gap is the point at which a person still decides. The orange dot sits in
 * that gap, and is the only saturated colour in the console's chrome: every
 * other colour on screen belongs to a job-card state and means something.
 *
 * Drawn rather than imported, so it inherits `currentColor` and needs no asset
 * pipeline.
 */
function LoopMark(): React.JSX.Element {
  return (
    <span className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        className="size-[17px]"
        aria-hidden="true"
      >
        <path d="M20 12a8 8 0 1 1-3.4-6.5" />
      </svg>
      <span
        className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand"
        aria-hidden="true"
      />
    </span>
  );
}
