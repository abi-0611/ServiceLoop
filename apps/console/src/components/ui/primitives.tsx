import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui-style primitives, written in-repo rather than pulled from a
 * generator so the console has no hidden component dependency. Same API,
 * same class-variance-authority pattern.
 *
 * Two rules hold everything here together:
 *
 *   1. **Every interactive surface answers the finger.** An advisor taps these
 *      with a glove on, so nothing is smaller than 44px and everything that can
 *      be pressed visibly moves when it is.
 *   2. **Motion is transform and opacity only.** These components render inside
 *      lists of a hundred job cards; anything that animates a colour, a shadow
 *      radius or a layout property would cost a repaint per frame per card.
 */

const buttonVariants = cva(
  [
    'group/btn relative inline-flex items-center justify-center gap-2 overflow-hidden whitespace-nowrap',
    'rounded-md text-sm font-medium tracking-tight',
    'transition-[transform,background-color,border-color,color,box-shadow] duration-200 ease-swift',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:scale-[0.98]',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    // The neon-button hairline, in the theme's own ink. `--hairline-hue` is
    // set per variant below, because the light has to be visible against the
    // fill it sits on: white on a solid ink button, ink on a pale one.
    'hairline',
  ].join(' '),
  {
    variants: {
      variant: {
        // Flat ink. The lightening on hover is a *brightness* step rather than
        // a colour change, so the button never stops being the same object —
        // which is what a physical control does when a finger approaches it.
        default:
          'bg-primary text-primary-foreground shadow-sm [--hairline-hue:0_0%_100%] hover:brightness-125 hover:shadow-md',
        secondary:
          'bg-secondary text-secondary-foreground shadow-xs [--hairline-hue:var(--foreground)] hover:bg-secondary/70',
        outline:
          'border border-input bg-background shadow-xs [--hairline-hue:var(--primary)] hover:border-foreground/30 hover:bg-accent hover:text-accent-foreground',
        ghost: '[--hairline-hue:var(--foreground)] hover:bg-accent hover:text-accent-foreground',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm [--hairline-hue:0_0%_100%] hover:brightness-110 hover:shadow-md',
        // Emphasis without commitment: reads as primary, weighs as secondary.
        soft: 'bg-primary-soft text-primary shadow-xs [--hairline-hue:var(--primary)] hover:bg-primary/15 dark:text-primary',
      },
      size: {
        // 44px minimum touch target: advisors use this on a phone.
        default: 'h-11 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-12 rounded-lg px-6 text-base',
        icon: 'h-11 w-11',
        'icon-sm': 'h-9 w-9 rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : 'button';
    return (
      <Component className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

const fieldClasses = [
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base',
  'shadow-xs transition-[border-color,box-shadow,background-color] duration-200 ease-swift',
  'placeholder:text-muted-foreground/70',
  'hover:border-muted-foreground/40',
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:ring-offset-0',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input type={type} ref={ref} className={cn(fieldClasses, className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(fieldClasses, 'h-auto min-h-24 resize-y py-2.5 text-sm leading-relaxed', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-sm font-medium leading-none text-foreground', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      fieldClasses,
      // Room for the caret we draw ourselves, so the control matches an Input
      // instead of matching the operating system.
      'cursor-pointer appearance-none bg-[length:16px] bg-[right_0.65rem_center] bg-no-repeat pr-9',
      "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 24 24%27 stroke-width=%272%27 stroke=%27%2364748b%27%3E%3Cpath stroke-linecap=%27round%27 stroke-linejoin=%27round%27 d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E')]",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h3 className={cn('text-base font-semibold leading-tight', className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-4 pt-0', className)} {...props} />;
}

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors duration-200',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground ring-border',
        info: 'bg-sky-50 text-sky-800 ring-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/30',
        warn: 'bg-amber-50 text-amber-900 ring-amber-400 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/35',
        success:
          'bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30',
        danger:
          'bg-rose-50 text-rose-800 ring-rose-300 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/30',
        brand:
          'bg-primary-soft text-primary ring-primary/25 dark:bg-primary/15 dark:text-primary dark:ring-primary/30',
        // No fill at all. For a label that has to sit *on* a coloured or
        // photographic surface without competing with it — the delivery panel
        // and the media chips in a message bubble.
        outline: 'bg-transparent text-foreground/80 ring-border',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/**
 * A live dot. Small enough to sit inside a badge, loud enough to be the reason
 * somebody looks at the badge.
 */
export function LiveDot({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cn('relative inline-flex size-1.5 shrink-0', className)}>
      <span className="ping-dot absolute inset-0 rounded-full opacity-70" />
      <span className="relative size-1.5 rounded-full bg-current" />
    </span>
  );
}

/**
 * The heading block every page opens with.
 *
 * It exists so the `<h1>`, the sentence under it and the page's actions cannot
 * drift apart between screens — the console has nineteen of them, and the
 * difference between a product and a collection of pages is largely whether
 * their headers agree.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'animate-enter flex flex-wrap items-start justify-between gap-x-4 gap-y-3',
        className,
      )}
    >
      <div className="min-w-0">
        {/* The eyebrow is set in the mono cut. It is a filing label — which
            drawer of the console this screen lives in — and setting labels in
            mono while sentences stay in the sans is the one typographic rule
            this product keeps everywhere, from a plate to a page header. */}
        {eyebrow !== undefined && (
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description !== undefined && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A band heading, ruled to the right margin.
 *
 * The rule is doing real work rather than decoration: the analytics page stacks
 * four unlabelled grids of tiles, and a line that runs to the edge is what
 * makes each one read as a closed set instead of as tiles that happen to be
 * near each other.
 */
export function SectionHeading({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h2
      className={cn(
        'flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </h2>
  );
}

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('skeleton rounded-md', className)} {...props} />;
}

const alertVariants = cva(
  'flex items-start gap-2.5 rounded-md border-l-2 py-2.5 pl-3 pr-3 text-sm leading-relaxed [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        info: 'border-l-primary bg-primary-soft/60 text-foreground dark:bg-primary/10',
        success:
          'border-l-emerald-600 bg-emerald-50 text-emerald-900 dark:border-l-emerald-400 dark:bg-emerald-500/10 dark:text-emerald-200',
        warn: 'border-l-amber-500 bg-amber-50 text-amber-900 dark:border-l-amber-400 dark:bg-amber-500/10 dark:text-amber-200',
        danger: 'border-l-destructive bg-destructive/5 text-destructive',
        neutral: 'border-l-border bg-muted/60 text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

/**
 * One notice, in the shape every notice in this console takes.
 *
 * A ruled left edge rather than a filled box with an icon roundel: these appear
 * *inside* dense surfaces — under a reply box, inside a review card, beside a
 * form field — where a full-width tinted panel would read as a section break
 * and push the thing it is talking about off the screen.
 *
 * `role` is a prop rather than a fixed value because the two cases are
 * genuinely different: something that just went wrong in response to a tap is
 * an `alert` and should interrupt a screen reader, while a standing condition —
 * "this window is closed", "only an owner can change this" — is `status` and
 * should not.
 */
export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  icon?: React.ReactNode;
}

export function Alert({
  className,
  tone,
  icon,
  children,
  role = 'status',
  ...props
}: AlertProps): React.JSX.Element {
  return (
    <div role={role} className={cn(alertVariants({ tone }), className)} {...props}>
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A labelled control, with its description and its error.
 *
 * The wiring is the point. `aria-describedby` is assembled from whichever of
 * the two are actually present, and the error takes over that role when it
 * appears — so a screen reader reads "Price floor, percent of list, must be
 * between 50 and 100" rather than announcing a number field with no hint that
 * anything is wrong with it. Doing that by hand at every call site is how forms
 * end up accessible on the three fields somebody remembered.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  /** Exactly one form control. Its `id` and ARIA wiring are supplied here. */
  children: React.ReactElement<Record<string, unknown>>;
  className?: string;
}): React.JSX.Element {
  const showError = typeof error === 'string' && error.length > 0;
  const describedBy =
    [hint !== undefined ? `${id}-hint` : null, showError ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required === true && (
          <span className="text-destructive" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </Label>

      {/* Cloned rather than handed a render prop, so the four forms that
          already write `<Field label="…"><Input/></Field>` keep reading the way
          they do — and so the wiring cannot be forgotten at a call site, which
          is exactly how the console ended up with four local Fields, none of
          which set `htmlFor` and none of which pointed a control at its hint. */}
      {React.cloneElement(children, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': showError ? true : undefined,
        required,
        // The caller's own props win, so a field can still opt out of anything
        // above by setting it explicitly on the control.
        ...(children.props as Record<string, unknown>),
      })}

      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {showError && (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="animate-enter relative overflow-hidden rounded-md border border-dashed border-border bg-card/40 px-6 py-16 text-center">
      {/* The grid says "nothing here yet" without a cartoon saying it. */}
      <div className="ruled fade-out-b pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
      <div className="relative flex flex-col items-center justify-center">
        <div
          className="mb-4 flex size-11 items-center justify-center rounded-md bg-primary-soft text-primary ring-1 ring-inset ring-primary/15 [&_svg]:size-5"
          aria-hidden="true"
        >
          {icon ?? <DefaultEmptyIcon />}
        </div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
        {action !== undefined && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}

function DefaultEmptyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
      />
    </svg>
  );
}
