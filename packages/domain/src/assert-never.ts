/**
 * Exhaustiveness guard. Adding a member to a union makes every `switch` that
 * ends in `assertNever` fail to compile, which is how new job-card states and
 * events are prevented from silently falling through the state machine.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
