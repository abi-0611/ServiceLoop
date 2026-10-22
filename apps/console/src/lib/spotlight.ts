/**
 * The attributes that mark an element as lit by a `<SpotlightArea>`.
 *
 * This lives in `lib` rather than beside the component on purpose. `SpotlightArea`
 * is a `'use client'` module, and everything a client module exports — including
 * a plain object like this one — is replaced by a client *reference* when a
 * server component imports it. Spreading that reference onto a server-rendered
 * `<Card>` fails at render time with a message about reading `call` of
 * undefined, which is a long way from the mistake that caused it.
 *
 * Keeping the constant on this side of the boundary lets a server component
 * opt a card into the effect without becoming a client component itself, which
 * is the whole point of the mark-and-delegate design.
 */
export const spotlightProps = {
  'data-spotlight': true,
} as const;
