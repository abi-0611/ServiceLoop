import type { z } from 'zod';

/**
 * zod → JSON Schema, for tool definitions (phase 3.1).
 *
 * A tool declares its arguments once, in zod. That schema is what the
 * `ToolRegistry` validates against, and this function is what the *model* is
 * shown. One declaration, two consumers — so a tool whose description and
 * validation disagree cannot exist.
 *
 * Deliberately narrow. It covers the node types tool arguments actually use and
 * **throws** on anything else, rather than degrading to a permissive
 * `{"type": "object"}`. A tool whose schema cannot be expressed must fail when
 * it is registered, at build and test time, not at runtime with a model free to
 * invent whatever argument shape it likes — that is precisely the failure L5
 * exists to prevent.
 */

export class UnsupportedSchemaError extends Error {
  constructor(
    readonly path: string,
    readonly typeName: string,
  ) {
    super(
      `Cannot express zod type "${typeName}" at ${path === '' ? '(root)' : path} as JSON Schema for a tool definition`,
    );
    this.name = 'UnsupportedSchemaError';
  }
}

type JsonSchema = Record<string, unknown>;

/** Converts a zod object schema into the JSON Schema a tool definition carries. */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const converted = convert(schema, '');
  if (converted['type'] !== 'object') {
    throw new UnsupportedSchemaError('', 'tool arguments must be an object schema');
  }
  return converted;
}

/**
 * Dispatch is on zod's own `_def.typeName` tag, not on `instanceof`.
 *
 * Tool schemas are declared in one package and converted in another, and under
 * pnpm those two can resolve different copies of zod — at which point every
 * `instanceof` check silently returns false and this function throws on a
 * perfectly ordinary object. The tag is stable within zod v3 and immune to it.
 */
function convert(schema: z.ZodTypeAny, path: string): JsonSchema {
  const description = schema.description;
  const withDescription = (base: JsonSchema): JsonSchema =>
    description === undefined ? base : { ...base, description };

  const def = schema._def as {
    typeName?: string;
    innerType?: z.ZodTypeAny;
    type?: z.ZodTypeAny;
    schema?: z.ZodTypeAny;
    values?: unknown;
    value?: unknown;
    options?: z.ZodTypeAny[];
    defaultValue?: () => unknown;
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
  };

  switch (def.typeName) {
    case 'ZodString':
      return withDescription(stringSchema(schema as z.ZodString));
    case 'ZodNumber':
      return withDescription(numberSchema(schema as z.ZodNumber));
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' });
    case 'ZodLiteral':
      return withDescription({ const: def.value });
    case 'ZodEnum':
      return withDescription({ type: 'string', enum: [...((def.values as string[]) ?? [])] });
    case 'ZodNativeEnum':
      return withDescription({
        enum: Object.values((def.values as Record<string, string | number>) ?? {}),
      });
    case 'ZodArray': {
      const element = def.type as z.ZodTypeAny;
      const array: JsonSchema = { type: 'array', items: convert(element, `${path}[]`) };
      if (def.minLength != null) array['minItems'] = def.minLength.value;
      if (def.maxLength != null) array['maxItems'] = def.maxLength.value;
      return withDescription(array);
    }
    case 'ZodObject':
      return withDescription(objectSchema(schema as z.ZodObject<z.ZodRawShape>, path));
    case 'ZodOptional':
      // Optionality is expressed by `required`, not by the member schema.
      return convert(def.innerType as z.ZodTypeAny, path);
    case 'ZodNullable':
      return withDescription({
        anyOf: [convert(def.innerType as z.ZodTypeAny, path), { type: 'null' }],
      });
    case 'ZodDefault': {
      const inner = convert(def.innerType as z.ZodTypeAny, path);
      return withDescription({ ...inner, default: def.defaultValue?.() });
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = [...((def.options as z.ZodTypeAny[]) ?? [])];
      return withDescription({
        anyOf: options.map((option, index) => convert(option, `${path}|${index}`)),
      });
    }
    case 'ZodEffects':
      // `.refine`/`.transform` narrows what is *accepted*; the wire shape is the
      // inner schema, and the registry re-validates with the real thing anyway.
      return convert(def.schema as z.ZodTypeAny, path);
    default:
      throw new UnsupportedSchemaError(path, def.typeName ?? schema.constructor.name);
  }
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>, path: string): JsonSchema {
  const shape = schema.shape;
  const properties: JsonSchema = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const child = value as z.ZodTypeAny;
    properties[key] = convert(child, path === '' ? key : `${path}.${key}`);
    if (!isOptionalNode(child)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    required,
    // Tool arguments are a closed set: an extra key is a hallucinated argument,
    // and it should be refused by the provider's own validator before it ever
    // reaches ours.
    additionalProperties: false,
  };
}

/** Optional or defaulted members are not `required` in JSON Schema. */
function isOptionalNode(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName?: string }).typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

function stringSchema(schema: z.ZodString): JsonSchema {
  const base: JsonSchema = { type: 'string' };
  for (const check of schema._def.checks) {
    if (check.kind === 'min') base['minLength'] = check.value;
    if (check.kind === 'max') base['maxLength'] = check.value;
    if (check.kind === 'uuid') base['format'] = 'uuid';
    if (check.kind === 'email') base['format'] = 'email';
    if (check.kind === 'url') base['format'] = 'uri';
    if (check.kind === 'datetime') base['format'] = 'date-time';
    if (check.kind === 'regex') base['pattern'] = check.regex.source;
  }
  return base;
}

function numberSchema(schema: z.ZodNumber): JsonSchema {
  const base: JsonSchema = { type: schema.isInt ? 'integer' : 'number' };
  for (const check of schema._def.checks) {
    if (check.kind === 'min') base[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
    if (check.kind === 'max') base[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
  }
  return base;
}

