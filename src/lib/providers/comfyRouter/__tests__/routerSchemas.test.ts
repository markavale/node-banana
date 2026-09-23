/**
 * Every bound model's request, checked against the schema the Router
 * validates with.
 *
 * For each model in families.json this builds two bodies: the smallest run
 * (prompt, required inputs, no settings) and the fullest (every handle
 * filled), and validates both against the model's published request
 * schema. It also checks the result paths exist in the response schema.
 *
 * The schemas are fetched by `npm run comfy:router-sync` into
 * .scratch/comfy-router-schemas (public, no key needed); the suite skips
 * when that folder is absent, so CI stays hermetic.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { routerBindings, type RouterBinding } from "../families";
import { buildRouterBody, type RouterRequestInput } from "../request";
import { deriveParams, flatten, requestSchema, type JsonSchema, type OpenApi } from "../schema";

const DIR = process.env.COMFY_ROUTER_SCHEMAS ?? join(process.cwd(), ".scratch/comfy-router-schemas");
const available = existsSync(DIR);

function load(id: string): OpenApi {
  return JSON.parse(readFileSync(join(DIR, `${id.replace("/", "__")}.json`), "utf8")) as OpenApi;
}

/** Inline every $ref and turn OpenAPI `nullable` into a JSON Schema union, for Ajv. */
function toJsonSchema(doc: OpenApi, node: unknown, depth = 0): unknown {
  if (depth > 40 || !node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => toJsonSchema(doc, item, depth + 1));
  let obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.split("/").pop()!;
    const { $ref: _ref, ...rest } = obj;
    obj = { ...(doc.components?.schemas?.[name] as Record<string, unknown>), ...rest };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "nullable" || key === "example" || key === "examples" || key === "discriminator" || key === "xml") continue;
    out[key] = toJsonSchema(doc, value, depth + 1);
  }
  if (obj.nullable === true) return { anyOf: [out, { type: "null" }] };
  return out;
}

const PNG = { base64: "iVBORw0KGgo=", dataUrl: "data:image/png;base64,iVBORw0KGgo=", url: "https://example.com/a.png", mime: "image/png" };
const MP4 = { base64: "AAAAIGZ0eXA=", dataUrl: "data:video/mp4;base64,AAAAIGZ0eXA=", url: "https://example.com/a.mp4", mime: "video/mp4", duration: 4 };
const MP3 = { base64: "SUQzBAA=", dataUrl: "data:audio/mpeg;base64,SUQzBAA=", url: "https://example.com/a.mp3", mime: "audio/mpeg" };
const SAMPLE = { image: PNG, video: MP4, audio: MP3 } as const;

function input(binding: RouterBinding, full: boolean): RouterRequestInput {
  const media: RouterRequestInput["media"] = {};
  for (const handle of binding.inputs) {
    if (handle.type === "text") continue;
    if (!full && !handle.required) continue;
    const sample = SAMPLE[handle.type as keyof typeof SAMPLE] ?? PNG;
    media[handle.name] = Array.from({ length: full ? Math.min(handle.max ?? 1, 2) : 1 }, () => sample);
  }
  return { prompt: "a lighthouse at dusk", negativePrompt: full ? "blurry" : undefined, media, randomSeed: () => 42 };
}

/** Does a result path exist in the response schema? `[*]`, `[0]` and `[k=v]` step into array items. */
function pathInSchema(doc: OpenApi, root: JsonSchema, path: string): boolean {
  let nodes: JsonSchema[] = [root];
  for (const part of path.split(".").filter(Boolean)) {
    const [, key, brackets] = /^([^[]*)(.*)$/.exec(part)!;
    const next: JsonSchema[] = [];
    for (const node of nodes) {
      const flat = flatten(doc, node);
      const branches = [flat, ...(flat.oneOf ?? []), ...(flat.anyOf ?? [])].map((branch) => flatten(doc, branch));
      for (const branch of branches) {
        let child: JsonSchema | undefined = key ? branch.properties?.[key] : branch;
        if (key && !child && (branch.additionalProperties === true || typeof branch.additionalProperties === "object" || !branch.properties)) {
          child = typeof branch.additionalProperties === "object" ? branch.additionalProperties : {};
        }
        if (!child) continue;
        let current = flatten(doc, child);
        for (let i = 0; i < (brackets.match(/\[/g)?.length ?? 0); i++) current = flatten(doc, current.items ?? {});
        next.push(current);
      }
    }
    if (next.length === 0) return false;
    nodes = next;
  }
  return true;
}

function responseSchema(doc: OpenApi): JsonSchema | null {
  for (const path of Object.values(doc.paths ?? {})) {
    const op = (path as Record<string, { responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> }>).post;
    const content = op?.responses?.["200"]?.content;
    const schema = content?.["application/json"]?.schema;
    if (schema) return schema;
  }
  return null;
}

describe.skipIf(!available)("Router request bodies match the published schemas", () => {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });

  for (const binding of routerBindings()) {
    it(binding.id, () => {
      const doc = load(binding.id);
      const schema = toJsonSchema(doc, requestSchema(doc)!) as object;
      const validate = ajv.compile(schema);
      const derived = deriveParams(doc, binding.params, binding.paramOverrides);
      const problems: string[] = [];

      for (const full of [false, true]) {
        const body = buildRouterBody(binding, derived, input(binding, full));
        if (!validate(body)) {
          problems.push(
            `${full ? "full" : "minimal"}: ${ajv.errorsText(validate.errors, { separator: "; " })}\n  body: ${JSON.stringify(body).slice(0, 400)}`
          );
        }
      }

      const response = responseSchema(doc);
      if (response && !binding.result.binary) {
        for (const candidate of binding.result.media ?? []) {
          const path = candidate.split("|")[0]!;
          if (!pathInSchema(doc, response, path)) problems.push(`result path not in response schema: ${path}`);
        }
      }

      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});
