/**
 * Settings from a Router schema.
 *
 * Every model's request schema is published (GET /v2/models/{id}/openapi.json,
 * or docs.comfy.org/router-schemas/{id}.json) and it is exactly what the
 * Router validates. So the node's settings are read from it rather than
 * written by hand: type, allowed values, range, default and description
 * all come from the schema, and a family's overrides only narrow what the
 * schema leaves loose (a free-string aspect ratio, a default the partner
 * requires but the schema does not declare).
 */
import type { ModelParameter } from "../types";

export type OpenApi = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
  info?: { version?: string };
  /** Who else can serve the model, besides Comfy. */
  "x-comfy-router-alt-providers"?: Array<{ provider?: string }>;
};

interface OpenApiOperation {
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  description?: string;
  title?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  nullable?: boolean;
  const?: unknown;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
}

/** A family's narrowing of one setting. */
export interface ParamOverride {
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  /** Leave the setting out of the node entirely. */
  hidden?: boolean;
  /** Send this value always, and do not show the setting. */
  value?: unknown;
  required?: boolean;
}

export interface ParamsSpec {
  /** JSON pointer into the request schema of the object whose properties are settings. */
  at?: string;
  exclude?: string[];
  /** Settings living elsewhere in the schema. */
  extra?: Array<{ at: string; name: string }>;
}

export function requestSchema(doc: OpenApi): JsonSchema | null {
  for (const path of Object.values(doc.paths ?? {})) {
    const op = path.post ?? Object.values(path)[0];
    const content = op?.requestBody?.content;
    const schema = content?.["application/json"]?.schema ?? Object.values(content ?? {})[0]?.schema;
    if (schema) return schema;
  }
  return null;
}

/** The 200 response's content type: JSON, or raw bytes (`*\/*`). */
export function responseContentType(doc: OpenApi): string | null {
  for (const path of Object.values(doc.paths ?? {})) {
    const op = path.post ?? Object.values(path)[0];
    const content = op?.responses?.["200"]?.content;
    if (content) return Object.keys(content)[0] ?? null;
  }
  return null;
}

function deref(doc: OpenApi, schema: JsonSchema | undefined, depth = 0): JsonSchema {
  if (!schema || depth > 16) return schema ?? {};
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    const target = doc.components?.schemas?.[name];
    return deref(doc, { ...target, ...withoutRef(schema) }, depth + 1);
  }
  return schema;
}

function withoutRef(schema: JsonSchema): JsonSchema {
  const { $ref: _ref, ...rest } = schema;
  return rest;
}

/**
 * Collapse `allOf` and a nullable `anyOf`/`oneOf` wrapper into one schema,
 * following refs. A union of genuinely different shapes keeps its first
 * object-typed branch, which is the documented body in Router schemas.
 */
export function flatten(doc: OpenApi, input: JsonSchema | undefined, depth = 0): JsonSchema {
  let schema = deref(doc, input, depth);
  if (depth > 16) return schema;
  if (schema.allOf?.length) {
    const merged: JsonSchema = { ...schema, allOf: undefined, properties: { ...(schema.properties ?? {}) }, required: [...(schema.required ?? [])] };
    for (const part of schema.allOf) {
      const flat = flatten(doc, part, depth + 1);
      Object.assign(merged.properties!, flat.properties ?? {});
      merged.required!.push(...(flat.required ?? []));
      for (const key of ["type", "enum", "default", "minimum", "maximum", "description", "format", "items"] as const) {
        if (merged[key] === undefined && flat[key] !== undefined) (merged as Record<string, unknown>)[key] = flat[key];
      }
    }
    schema = merged;
  }
  const union = schema.anyOf ?? schema.oneOf;
  // A union beside the schema's own properties only adds constraints ("one of
  // these fields is required"); the properties are the shape. Collapse only a
  // union that IS the shape (a nullable wrapper, a list of body variants).
  if (union?.length && !schema.properties) {
    const branches = union.map((branch) => flatten(doc, branch, depth + 1));
    const real = branches.filter((branch) => branch.type !== "null");
    // Prefer the branch that is the shape: an object, then a range ("-1 or 4..15"
    // is a range with a sentinel), then the widest list of values.
    const pick =
      real.find((branch) => branch.type === "object" || branch.properties) ??
      real.find((branch) => branch.minimum !== undefined || branch.maximum !== undefined) ??
      [...real].sort((a, b) => (b.enum?.length ?? 0) - (a.enum?.length ?? 0))[0];
    if (pick) {
      const enums = real.every((branch) => branch.enum) ? real.flatMap((branch) => branch.enum ?? []) : undefined;
      schema = {
        type: schema.type,
        ...pick,
        description: schema.description ?? pick.description,
        default: schema.default ?? pick.default,
        nullable: real.length < branches.length || schema.nullable,
        ...(enums ? { enum: enums } : {}),
      };
    }
  }
  return schema;
}

/** The schema at a JSON pointer (`/parameters`, `/generationConfig/imageConfig`), through properties and array items. */
export function schemaAt(doc: OpenApi, root: JsonSchema, pointer: string): JsonSchema | null {
  let node = flatten(doc, root);
  for (const part of pointer.split("/").filter(Boolean)) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (key === "items" || /^\d+$/.test(key)) {
      node = flatten(doc, node.items);
      continue;
    }
    const next = node.properties?.[key];
    if (!next) return null;
    node = flatten(doc, next);
  }
  return node;
}

function typeOf(schema: JsonSchema): ModelParameter["type"] | null {
  const raw = Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;
  if (raw === "string" || raw === "integer" || raw === "number" || raw === "boolean") return raw;
  if (raw === "array") return "array";
  if (!raw && schema.enum?.length) {
    const first = schema.enum.find((value) => value !== null);
    return typeof first === "number" ? (Number.isInteger(first) ? "integer" : "number") : typeof first === "boolean" ? "boolean" : "string";
  }
  return null;
}

/** Tidy a schema description for a tooltip: first sentence-ish, no markdown. */
function tidy(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const plain = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= 160) return plain;
  const cut = plain.slice(0, 160);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

function toParameter(name: string, schema: JsonSchema, required: boolean): ModelParameter | null {
  const type = typeOf(schema);
  if (!type) return null;
  // Arrays of plain values only (e.g. a list of style tags); arrays of objects are structure, not a setting.
  if (type === "array") {
    const item = schema.items;
    if (!item || (item.type !== "string" && !item.enum)) return null;
  }
  const values = schema.enum?.filter((value) => value !== null);
  const param: ModelParameter = { name, type };
  const description = tidy(schema.description ?? schema.title);
  if (description) param.description = description;
  if (schema.default !== undefined && schema.default !== null) param.default = schema.default;
  if (values?.length) param.enum = values;
  const min = schema.minimum ?? schema.exclusiveMinimum;
  const max = schema.maximum ?? schema.exclusiveMaximum;
  if (typeof min === "number") param.minimum = min;
  if (typeof max === "number") param.maximum = max;
  if (schema.const !== undefined) return null;
  if (required) param.required = true;
  return param;
}

export interface DerivedParam extends ModelParameter {
  /** Where the value goes in the body, as a JSON pointer to its parent object. */
  at: string;
  /** Always sent with this value; not shown. */
  fixed?: unknown;
}

/**
 * The model's settings: every property of the object at `spec.at` that is
 * not excluded, plus `spec.extra`, narrowed by `overrides`.
 */
export function deriveParams(
  doc: OpenApi,
  spec: ParamsSpec = {},
  overrides: Record<string, ParamOverride> = {}
): DerivedParam[] {
  const root = requestSchema(doc);
  if (!root) return [];
  const out: DerivedParam[] = [];
  const exclude = new Set(spec.exclude ?? []);

  const add = (name: string, schema: JsonSchema, required: boolean, at: string) => {
    const override = overrides[name];
    if (override?.hidden) return;
    const base = toParameter(name, flatten(doc, schema), required);
    if (!base && override?.value === undefined && !override?.enum) return;
    const param: DerivedParam = { ...(base ?? { name, type: "string" }), at };
    if (override) {
      if (override.enum) param.enum = override.enum;
      if (override.default !== undefined) param.default = override.default;
      if (override.minimum !== undefined) param.minimum = override.minimum;
      if (override.maximum !== undefined) param.maximum = override.maximum;
      if (override.description) param.description = override.description;
      if (override.required !== undefined) param.required = override.required;
      if (override.value !== undefined) param.fixed = override.value;
    }
    // A default outside a narrowed enum would be sent and rejected.
    if (param.enum && param.default !== undefined && !param.enum.includes(param.default)) {
      param.default = param.enum[0];
    }
    out.push(param);
  };

  const at = spec.at ?? "";
  const container = schemaAt(doc, root, at);
  if (container?.properties) {
    const required = new Set(container.required ?? []);
    for (const [name, schema] of Object.entries(container.properties)) {
      if (exclude.has(name)) continue;
      add(name, schema, required.has(name), at);
    }
  }
  for (const extra of spec.extra ?? []) {
    const parent = schemaAt(doc, root, extra.at);
    const schema = parent?.properties?.[extra.name];
    if (schema) add(extra.name, schema, (parent?.required ?? []).includes(extra.name), extra.at);
  }
  // Overrides may add a setting the schema leaves out of the container (rare).
  for (const [name, override] of Object.entries(overrides)) {
    if (out.some((param) => param.name === name) || override.hidden || exclude.has(name)) continue;
    if (override.enum || override.value !== undefined) {
      out.push({
        name,
        type: typeof (override.enum?.[0] ?? override.value) === "number" ? "number" : typeof (override.enum?.[0] ?? override.value) === "boolean" ? "boolean" : "string",
        ...(override.enum ? { enum: override.enum } : {}),
        ...(override.default !== undefined ? { default: override.default } : {}),
        ...(override.description ? { description: override.description } : {}),
        ...(override.value !== undefined ? { fixed: override.value } : {}),
        at,
      });
    }
  }
  return out;
}
