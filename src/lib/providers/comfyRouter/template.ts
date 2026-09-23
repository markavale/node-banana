/**
 * The Comfy Router binding language.
 *
 * Router forwards each partner's native request and response, so every wire
 * format is described once, as data: a request template the app fills from
 * the node's prompt, media and settings, and a list of paths where the
 * finished asset (or the partner's error) sits in the response. This module
 * is the interpreter for both halves. It is pure: media arrive already
 * encoded (see `ComfyMediaValue`), so uploading and downloading stay in the
 * server module.
 *
 * Template substitutions, inside any string value:
 *   {{prompt}} {{negative_prompt}}      the node's text
 *   {{param.NAME}}                      a setting, typed as the user set it
 *   {{input.NAME[0]}}                   first value of a media handle, in its declared encoding
 *   {{input.NAME[0].base64|dataUrl|url|mime|duration}}   one encoding explicitly (duration: seconds)
 *   {{input.NAME}}                      every value of a handle, as an array
 *   {{random.seed}}                     a random 32-bit integer
 * A string that is exactly one placeholder takes the value's own type; a
 * placeholder inside other text is interpolated as a string.
 *
 * Directives, as objects:
 *   { "$params": true }                          spread every exposed setting that has a value
 *   { "$each": "input.NAME", "max": N, "item": … }   one item per media value; inside an array it
 *                                                    splices in place, so it can sit beside literals
 *   "$slots": { "$slots": "input.NAME", "keys": [...], "value": … }   numbered sibling keys, one
 *                                                    per value (any key starting "$slots")
 *   { "$if": "input.NAME" | "param.NAME" | "prompt", "then": …, "else": … }   branch on whether
 *                                                    that has a value; no else drops the key
 *
 * Anything that resolves to nothing is dropped: a missing key, a missing
 * array item, an object or array left empty.
 */

export type Json = Record<string, unknown>;

/** One media value, pre-encoded every way a template may ask for. */
export interface ComfyMediaValue {
  /** Raw base64, no prefix. */
  base64?: string;
  /** `data:<mime>;base64,<b64>`. */
  dataUrl?: string;
  /** A public https URL (an upload, or the original remote URL). */
  url?: string;
  mime?: string;
  /** Length in seconds, for video and audio when the server could read it. */
  duration?: number;
}

export type MediaEncoding = "base64" | "dataUrl" | "url";

export interface TemplateContext {
  prompt?: string;
  negativePrompt?: string;
  /** Settings with a value, already defaulted. */
  params: Record<string, unknown>;
  /** Names of the settings `{ "$params": true }` spreads. */
  spreadParams: string[];
  /** Media per handle, in handle order. */
  media: Record<string, ComfyMediaValue[]>;
  /** Declared encoding per handle. */
  encodings: Record<string, MediaEncoding>;
  /** Injectable for tests. */
  randomSeed?: () => number;
}

const MISSING = Symbol("missing");
type Resolved = unknown | typeof MISSING;

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || value === MISSING;
}

function encode(value: ComfyMediaValue | undefined, as: string): unknown {
  if (!value) return MISSING;
  const out = as === "base64" ? value.base64 : as === "dataUrl" ? value.dataUrl : as === "url" ? value.url : as === "mime" ? value.mime : as === "duration" ? value.duration : undefined;
  return isEmpty(out) ? MISSING : out;
}

interface Scope {
  ctx: TemplateContext;
  item?: { value: ComfyMediaValue; handle: string; index: number };
}

/** Resolve one placeholder expression. */
function lookup(expr: string, scope: Scope): Resolved {
  const { ctx } = scope;
  if (expr === "prompt") return isEmpty(ctx.prompt) ? MISSING : ctx.prompt;
  if (expr === "negative_prompt") return isEmpty(ctx.negativePrompt) ? MISSING : ctx.negativePrompt;
  if (expr === "random.seed") return (ctx.randomSeed ?? (() => Math.floor(Math.random() * 4294967295)))();
  if (expr === "index") return scope.item ? scope.item.index : MISSING;

  if (expr === "item" || expr.startsWith("item.")) {
    const item = scope.item;
    if (!item) return MISSING;
    const as = expr === "item" ? ctx.encodings[item.handle] ?? "dataUrl" : expr.slice(5);
    return encode(item.value, as);
  }

  if (expr.startsWith("param.")) {
    const value = ctx.params[expr.slice(6)];
    return isEmpty(value) ? MISSING : value;
  }

  const media = /^input\.([A-Za-z0-9_]+)(?:\[(\d+)\])?(?:\.(base64|dataUrl|url|mime|duration))?$/.exec(expr);
  if (media) {
    const [, handle, index, as] = media;
    const values = ctx.media[handle!] ?? [];
    const encoding = as ?? ctx.encodings[handle!] ?? "dataUrl";
    if (index === undefined) {
      const all = values.map((value) => encode(value, encoding)).filter((value) => value !== MISSING);
      return all.length ? all : MISSING;
    }
    return encode(values[Number(index)], encoding);
  }

  throw new Error(`Unknown template placeholder {{${expr}}}`);
}

function substitute(text: string, scope: Scope): Resolved {
  const whole = WHOLE.exec(text);
  if (whole) return lookup(whole[1]!, scope);
  if (!text.includes("{{")) return text;
  let missing = false;
  const out = text.replace(ANY, (_, expr: string) => {
    const value = lookup(expr, scope);
    if (value === MISSING) {
      missing = true;
      return "";
    }
    return String(value);
  });
  return missing ? MISSING : out;
}

/** Does a `$if` condition hold? */
function holds(condition: string, scope: Scope): boolean {
  if (condition.startsWith("input.")) return (scope.ctx.media[condition.slice(6)] ?? []).length > 0;
  return lookup(condition, scope) !== MISSING;
}

function mediaFor(source: string, scope: Scope): { handle: string; values: ComfyMediaValue[] } {
  if (!source.startsWith("input.")) throw new Error(`$each/$slots source must be input.NAME, got ${source}`);
  const handle = source.slice(6);
  return { handle, values: scope.ctx.media[handle] ?? [] };
}

function eachItems(node: Json, scope: Scope): unknown[] {
  const { handle, values } = mediaFor(String(node.$each), scope);
  const max = typeof node.max === "number" ? node.max : values.length;
  const out: unknown[] = [];
  values.slice(0, max).forEach((value, index) => {
    const resolved = render(node.item, { ctx: scope.ctx, item: { value, handle, index } });
    if (resolved !== MISSING) out.push(resolved);
  });
  return out;
}

function render(node: unknown, scope: Scope): Resolved {
  if (typeof node === "string") return substitute(node, scope);
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const child of node) {
      if (child && typeof child === "object" && !Array.isArray(child) && "$each" in child) {
        out.push(...eachItems(child as Json, scope));
        continue;
      }
      const value = render(child, scope);
      if (value !== MISSING) out.push(value);
    }
    return out.length ? out : MISSING;
  }
  if (node && typeof node === "object") {
    const obj = node as Json;
    if ("$each" in obj) {
      const items = eachItems(obj, scope);
      return items.length ? items : MISSING;
    }
    if ("$if" in obj) {
      if (holds(String(obj.$if), scope)) return render(obj.then, scope);
      return "else" in obj ? render(obj.else, scope) : MISSING;
    }
    const out: Json = {};
    for (const [key, child] of Object.entries(obj)) {
      if (key === "$params") {
        if (child) {
          for (const name of scope.ctx.spreadParams) {
            const value = scope.ctx.params[name];
            if (!isEmpty(value) && !(name in out)) out[name] = value;
          }
        }
        continue;
      }
      if (key.startsWith("$slots")) {
        const spec = child as Json;
        const { handle, values } = mediaFor(String(spec.$slots ?? spec.source), scope);
        const keys = Array.isArray(spec.keys) ? (spec.keys as string[]) : [];
        values.slice(0, keys.length).forEach((value, index) => {
          const resolved = render(spec.value ?? "{{item}}", { ctx: scope.ctx, item: { value, handle, index } });
          if (resolved !== MISSING) out[keys[index]!] = resolved;
        });
        continue;
      }
      const value = render(child, scope);
      if (value !== MISSING) out[key] = value;
    }
    return Object.keys(out).length ? out : MISSING;
  }
  return node;
}

/**
 * Fill a request template. An object may hold several slot groups under
 * keys that start with `$slots` (`$slots`, `$slots_mask`, …), since JSON
 * cannot repeat a key.
 */
export function renderTemplate(template: unknown, ctx: TemplateContext): Json {
  const out = render(template, { ctx });
  return out === MISSING || !out || typeof out !== "object" || Array.isArray(out) ? {} : (out as Json);
}

/* ------------------------------------------------------------------ results */

export interface ResultErrorRule {
  path: string;
  /** Fail when the value is present and NOT one of these. */
  notIn?: string[];
  /** Fail when the value is one of these. */
  in?: string[];
  /** `{value}` is the value found; `{@path}` reads another path (e.g. a failure reason). */
  message?: string;
}

export interface ResultSpec {
  /** The 200 response is the asset's bytes, not JSON. */
  binary?: boolean;
  /**
   * Candidate paths to the output, tried in order. `a.b[0].c`, `a[*].c`
   * (first match). Suffix `|base64:<mime>` for raw base64, `|base64:@path`
   * to read the mime from a path (relative to the matched item's parent with
   * a leading `.`), `|dataUrl` for a value that already is one.
   */
  media?: string[];
  errors?: ResultErrorRule[];
  /** Force the output's mime type (e.g. image/svg+xml for vector output). */
  mime?: string;
}

export interface FoundMedia {
  /** http(s) URL to download, or a data URL. */
  source: string;
  mimeType?: string;
}

type Step = { key: string } | { index: number } | { any: true } | { where: string; equals: string };

function parsePath(path: string): Step[] {
  const steps: Step[] = [];
  for (const part of path.split(".").filter(Boolean)) {
    const match = /^([^[\]]*)((?:\[[^\]]+\])*)$/.exec(part);
    if (!match) throw new Error(`Bad result path ${path}`);
    if (match[1]) steps.push({ key: match[1] });
    for (const bracket of match[2]!.matchAll(/\[([^\]]+)\]/g)) {
      const inner = bracket[1]!;
      const filter = /^([A-Za-z0-9_]+)=(.*)$/.exec(inner);
      if (filter) steps.push({ where: filter[1]!, equals: filter[2]! });
      else steps.push(inner === "*" ? { any: true } : { index: Number(inner) });
    }
  }
  return steps;
}

/** Every value at a path, with the object that held it. */
function walk(root: unknown, steps: Step[]): Array<{ value: unknown; parent: unknown }> {
  let frontier: Array<{ value: unknown; parent: unknown }> = [{ value: root, parent: undefined }];
  for (const step of steps) {
    const next: Array<{ value: unknown; parent: unknown }> = [];
    for (const { value } of frontier) {
      if ("key" in step) {
        if (value && typeof value === "object" && !Array.isArray(value) && step.key in (value as Json)) {
          next.push({ value: (value as Json)[step.key], parent: value });
        }
      } else if (Array.isArray(value)) {
        if ("index" in step) {
          if (step.index < value.length) next.push({ value: value[step.index], parent: value });
        } else if ("where" in step) {
          for (const item of value) {
            if (item && typeof item === "object" && String((item as Json)[step.where]) === step.equals) next.push({ value: item, parent: value });
          }
        } else {
          for (const item of value) next.push({ value: item, parent: value });
        }
      }
    }
    frontier = next;
  }
  return frontier;
}

export function valueAt(root: unknown, path: string): unknown {
  return walk(root, parsePath(path))[0]?.value;
}

function present(value: unknown): value is string | number | boolean {
  return (typeof value === "string" && value.trim() !== "") || typeof value === "number" || typeof value === "boolean";
}

/** `{value}` is the value the rule matched; `{@a.b}` reads another path (empty when absent). */
function interpolate(message: string, value: string, result: unknown): string {
  return message
    .replace(/\{value\}/g, value)
    .replace(/\{@([^}]+)\}/g, (_, path: string) => {
      const found = valueAt(result, path);
      return present(found) ? String(found) : "";
    })
    .replace(/:\s*$/, "")
    .trim();
}

/** First error rule that fires, as a message; null when the result looks fine. */
export function resultError(result: unknown, rules: ResultErrorRule[] = []): string | null {
  for (const rule of rules) {
    const raw = valueAt(result, rule.path);
    // A list of reasons reads as one line.
    const value = Array.isArray(raw) ? raw.filter(present).join(", ") : raw;
    if (!present(value)) continue;
    const text = String(value);
    const fires = rule.notIn ? !rule.notIn.includes(text) : rule.in ? rule.in.includes(text) : true;
    if (fires) return interpolate(rule.message ?? "{value}", text, result);
  }
  return null;
}

/** The finished asset, or null when none of the paths holds one. */
export function findMedia(result: unknown, spec: ResultSpec): FoundMedia | null {
  for (const candidate of spec.media ?? []) {
    const [path, suffix] = candidate.split("|") as [string, string | undefined];
    const steps = parsePath(path);
    for (const { value, parent } of walk(result, steps)) {
      if (typeof value !== "string" || value === "") continue;
      if (!suffix) {
        if (/^(https?:|data:)/.test(value)) return { source: value, mimeType: spec.mime };
        continue;
      }
      if (suffix === "dataUrl") {
        if (value.startsWith("data:")) return { source: value, mimeType: spec.mime };
        continue;
      }
      if (suffix.startsWith("base64:")) {
        let mime = suffix.slice(7);
        if (mime.startsWith("@")) {
          const ref = mime.slice(1);
          const found = ref.startsWith(".")
            ? valueAt(Array.isArray(parent) ? value : parent, ref.slice(1))
            : valueAt(result, ref);
          mime = typeof found === "string" && found.includes("/") ? found : typeof found === "string" ? `image/${found}` : "application/octet-stream";
        }
        if (value.startsWith("data:")) return { source: value, mimeType: spec.mime };
        return { source: `data:${spec.mime ?? mime};base64,${value}`, mimeType: spec.mime ?? mime };
      }
    }
  }
  return null;
}

const OUTPUT_KEYS = /^(url|uri|urls|video|video_url|videourl|image|image_url|imageurl|images|videos|sample|output|outputs|result|results|audio|audio_url|model_url|glb|download_url|file_url|assets)$/i;
const INPUT_KEYS = /(input|prompt|reference|ref|source|first_frame|last_frame|mask|init|start|end_image|image_prompt|keyframe)/i;
const EXTENSIONS: Record<string, RegExp> = {
  image: /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i,
  video: /\.(mp4|mov|webm|m4v)(\?|$)/i,
  audio: /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i,
  "3d": /\.(glb|gltf|fbx|obj|usdz)(\?|$)/i,
};

/**
 * Last resort when none of a family's paths match: the first output-looking
 * URL anywhere in the result. An alternate serving provider can answer in
 * its own shape (Kling 3.0 Turbo served by Higgsfield comes back in classic
 * Kling form), so this looks under output-sounding keys only, never under
 * keys that echo inputs, and wants a file extension of the right kind.
 */
export function findMediaAnywhere(result: unknown, output: keyof typeof EXTENSIONS): FoundMedia | null {
  const wanted = EXTENSIONS[output];
  const seen = new Set<unknown>();
  const visit = (node: unknown, key: string, depth: number): FoundMedia | null => {
    if (depth > 12 || node === null || typeof node !== "object" || seen.has(node)) {
      if (typeof node === "string" && /^https:\/\//.test(node) && OUTPUT_KEYS.test(key) && wanted?.test(node)) return { source: node };
      return null;
    }
    seen.add(node);
    const entries: Array<[string, unknown]> = Array.isArray(node) ? node.map((item) => [key, item]) : Object.entries(node as Json);
    for (const [childKey, child] of entries) {
      if (INPUT_KEYS.test(childKey)) continue;
      const found = visit(child, childKey, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(result, "", 0);
}
