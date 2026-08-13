/**
 * Canonical JSON — deterministic serialisation used by the hash-chained audit
 * log and by prompt hashing.
 *
 * Rules: object keys sorted lexicographically by UTF-16 code unit, no
 * insignificant whitespace, `undefined` object properties dropped, `undefined`
 * array entries rendered as `null` (matching JSON.stringify), Dates rendered as
 * ISO-8601 strings, BigInt rendered as a decimal string. Cycles throw.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return serialise(value, new WeakSet<object>());
}

function serialise(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number (${String(value)})`);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
      return 'null';
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) throw new TypeError('canonicalJson: circular reference');
  seen.add(object);

  try {
    if (object instanceof Date) return JSON.stringify(object.toISOString());

    if (Array.isArray(object)) {
      return `[${object.map((entry) => serialise(entry, seen)).join(',')}]`;
    }

    if (object instanceof Map) {
      return serialise(Object.fromEntries(object.entries()), seen);
    }
    if (object instanceof Set) {
      return serialise([...object].sort(), seen);
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${serialise(record[key], seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}
