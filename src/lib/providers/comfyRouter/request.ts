/**
 * From a node's inputs to a Router request body.
 *
 * Pure: media arrive already encoded (the server module uploads what a
 * partner wants as a URL before calling this), and settings arrive as the
 * node sent them. Settings are coerced to their schema type, empty ones are
 * dropped, and a setting the partner requires but the schema gives no
 * default gets the family's default, so a run never fails on a field the
 * user could not see.
 */
import type { RouterBinding } from "./families";
import type { DerivedParam } from "./schema";
import { renderTemplate, type ComfyMediaValue, type Json, type MediaEncoding } from "./template";

export interface RouterRequestInput {
  prompt: string;
  negativePrompt?: string;
  parameters?: Record<string, unknown>;
  /** Encoded media per handle name. */
  media: Record<string, ComfyMediaValue[]>;
  /** Per-handle encodings that replace the binding's (media sent by URL for an alternate provider). */
  encodings?: Record<string, MediaEncoding>;
  randomSeed?: () => number;
}

function coerce(param: DerivedParam, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if ((param.type === "integer" || param.type === "number") && typeof value === "string") {
    const number = Number(value);
    if (Number.isNaN(number)) return undefined;
    return param.type === "integer" ? Math.round(number) : number;
  }
  if (param.type === "boolean" && typeof value === "string") return value === "true";
  if (param.type === "integer" && typeof value === "number") return Math.round(value);
  // An enum of numbers set from a text control arrives as a string.
  if (param.enum && typeof value === "string" && !param.enum.includes(value)) {
    const match = param.enum.find((option) => String(option) === value);
    if (match !== undefined) return match;
  }
  return value;
}

/** The settings to send: the user's, then fixed values, then required defaults. */
export function resolveParams(derived: DerivedParam[], user: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of derived) {
    if (param.fixed !== undefined) {
      out[param.name] = param.fixed;
      continue;
    }
    const value = coerce(param, user[param.name]);
    if (value !== undefined) {
      out[param.name] = value;
    } else if (param.required && param.default !== undefined) {
      out[param.name] = param.default;
    }
  }
  return out;
}

/** Missing required handles, as a message the node can show. */
export function missingInputs(binding: RouterBinding, input: RouterRequestInput): string | null {
  const missing: string[] = [];
  for (const handle of binding.inputs) {
    if (!handle.required) continue;
    if (handle.name === "prompt") {
      if (!input.prompt.trim()) missing.push("a prompt");
      continue;
    }
    if (handle.name === "negative_prompt") continue;
    if (!(input.media[handle.name]?.length)) missing.push(handle.label.toLowerCase());
  }
  if (missing.length === 0) return null;
  return `${binding.name} needs ${missing.join(" and ")}`;
}

export function buildRouterBody(binding: RouterBinding, derived: DerivedParam[], input: RouterRequestInput): Json {
  const params = resolveParams(derived, input.parameters);
  const container = binding.params.at ?? "";
  const spreadParams = derived.filter((param) => param.at === container).map((param) => param.name);
  const encodings: Record<string, MediaEncoding> = {};
  for (const handle of binding.inputs) {
    const encoding = input.encodings?.[handle.name] ?? handle.encoding;
    if (encoding) encodings[handle.name] = encoding;
  }
  // Each handle takes at most its declared number of values.
  const media: Record<string, ComfyMediaValue[]> = {};
  for (const handle of binding.inputs) {
    const values = input.media[handle.name];
    if (values?.length) media[handle.name] = values.slice(0, handle.max ?? values.length);
  }
  return renderTemplate(binding.body, {
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    params,
    spreadParams,
    media,
    encodings,
    randomSeed: input.randomSeed,
  });
}
