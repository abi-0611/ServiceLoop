/**
 * Small structural helpers used by config patching and audit diffs.
 * Arrays are treated as atomic values — replacing an escalation ladder replaces
 * the whole rung list rather than merging rung-by-rung, which is the only
 * behaviour an operator can reason about.
 */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function deepMerge<T extends PlainObject>(base: T, patch: PlainObject): T {
  const output: PlainObject = { ...base };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    const baseValue = output[key];
    output[key] =
      isPlainObject(baseValue) && isPlainObject(patchValue)
        ? deepMerge(baseValue, patchValue)
        : patchValue;
  }

  return output as T;
}

export interface FieldDiff {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Dotted-path diff of two documents; arrays and scalars compare by value. */
export function diffPaths(before: unknown, after: unknown, prefix = ''): FieldDiff[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const diffs: FieldDiff[] = [];
    for (const key of [...keys].sort()) {
      diffs.push(...diffPaths(before[key], after[key], prefix === '' ? key : `${prefix}.${key}`));
    }
    return diffs;
  }

  return sameValue(before, after) ? [] : [{ path: prefix, before, after }];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => sameValue(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return diffPaths(a, b).length === 0;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}
