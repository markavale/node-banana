/**
 * The live Comfy Router catalog, server side.
 *
 * Which models exist comes from the Router (GET /v2/models, paginated, with
 * the key); which of those the app can drive, and how, comes from
 * families.json. Each model's settings are read from its published schema
 * (GET /v2/models/{id}/openapi.json with the key, or the public copy on
 * docs.comfy.org without one), so they always match what the Router
 * validates. Both are cached in memory: the list for ten minutes, a schema
 * for six hours, and a stale copy is served if a refresh fails.
 */
import type { ModelInput, ModelParameter, ProviderModel } from "../types";
import { COMFY_ROUTER_BASE_URL, COMFY_ROUTER_MODELS_URL } from "../comfyRouter";
import { routerBinding, routerBindings, type RouterBinding } from "./families";
import { deriveParams, type DerivedParam, type OpenApi } from "./schema";

const LIST_TTL_MS = 10 * 60 * 1000;
const SCHEMA_TTL_MS = 6 * 60 * 60 * 1000;
const PUBLIC_SCHEMA_BASE = "https://docs.comfy.org/router-schemas";

interface Cached<T> {
  value: T;
  at: number;
}

let listCache: Cached<Set<string>> | null = null;
const schemaCache = new Map<string, Cached<OpenApi>>();
const inflight = new Map<string, Promise<OpenApi>>();

function routerPath(id: string): string {
  const [provider, ...rest] = id.split("/");
  return `${encodeURIComponent(provider ?? "")}/${encodeURIComponent(rest.join("/"))}`;
}

/** Every model id the Router serves right now, or null when it cannot be reached. */
export async function listRouterModelIds(apiKey: string | null): Promise<Set<string> | null> {
  if (!apiKey) return null;
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.value;
  try {
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = `${COMFY_ROUTER_BASE_URL}/v2/models?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetch(url, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`models list ${response.status}`);
      const body = (await response.json()) as { data?: Array<{ id?: string }>; has_more?: boolean; next_cursor?: string | null };
      for (const item of body.data ?? []) if (item.id) ids.add(item.id);
      cursor = body.next_cursor ?? null;
      if (!body.has_more || !cursor) break;
    }
    listCache = { value: ids, at: Date.now() };
    return ids;
  } catch (error) {
    console.warn(`[comfy-router] model list unavailable: ${error instanceof Error ? error.message : error}`);
    return listCache?.value ?? null;
  }
}

async function fetchSchema(id: string, apiKey: string | null): Promise<OpenApi> {
  const attempts: Array<[string, Record<string, string>]> = [];
  if (apiKey) attempts.push([`${COMFY_ROUTER_BASE_URL}/v2/models/${routerPath(id)}/openapi.json`, { "X-API-Key": apiKey }]);
  attempts.push([`${PUBLIC_SCHEMA_BASE}/${routerPath(id)}.json`, {}]);
  let lastError: unknown = null;
  for (const [url, headers] of attempts) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${response.status}`);
      return (await response.json()) as OpenApi;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Schema for ${id} unavailable (${lastError instanceof Error ? lastError.message : lastError})`);
}

/** A model's published schema, cached; a stale copy is kept if a refresh fails. */
export async function getRouterSchema(id: string, apiKey: string | null): Promise<OpenApi> {
  const cached = schemaCache.get(id);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.value;
  const pending = inflight.get(id);
  if (pending) return pending;
  const promise = fetchSchema(id, apiKey)
    .then((doc) => {
      schemaCache.set(id, { value: doc, at: Date.now() });
      return doc;
    })
    .catch((error) => {
      if (cached) return cached.value;
      throw error;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}

/** Seed the cache (tests, or a snapshot loaded at startup). */
export function primeRouterSchema(id: string, doc: OpenApi): void {
  schemaCache.set(id, { value: doc, at: Date.now() });
}

export interface ResolvedRouterModel {
  binding: RouterBinding;
  params: DerivedParam[];
  /** Who can serve it, default ("comfy") first; one entry when there is no choice. */
  providers: string[];
}

/**
 * Serving providers from the schema's `x-comfy-router-alt-providers`, which
 * the Router publishes per model, falling back to the binding's list.
 */
export function servingProviders(doc: OpenApi, binding: RouterBinding): string[] {
  const alternates = doc["x-comfy-router-alt-providers"];
  if (Array.isArray(alternates) && alternates.length) {
    return ["comfy", ...alternates.map((entry) => entry.provider).filter((name): name is string => typeof name === "string" && name !== "comfy")];
  }
  return binding.providers.length ? binding.providers : ["comfy"];
}

export async function resolveRouterModel(id: string, apiKey: string | null): Promise<ResolvedRouterModel | null> {
  const binding = routerBinding(id);
  if (!binding) return null;
  const doc = await getRouterSchema(id, apiKey);
  return { binding, params: deriveParams(doc, binding.params, binding.paramOverrides), providers: servingProviders(doc, binding) };
}

/** The setting that picks who serves a model; not part of the request body. */
export const ROUTER_PROVIDER_PARAM = "model_provider";

/**
 * Node settings: what the user can change (fixed values are sent, not
 * shown), led by the serving provider for models that have more than one.
 */
export function nodeParameters(params: DerivedParam[], providers: string[] = []): ModelParameter[] {
  const settings: ModelParameter[] = params
    .filter((param) => param.fixed === undefined)
    .map(({ at: _at, fixed: _fixed, ...param }) => param);
  if (providers.length > 1) {
    settings.unshift({
      name: ROUTER_PROVIDER_PARAM,
      type: "string",
      enum: providers,
      default: providers[0],
      description: "Who runs the model. comfy routes to its maker; the others run the same model from the same settings.",
    });
  }
  return settings;
}

/** Node handles, from the binding's media and text inputs. */
export function nodeInputs(binding: RouterBinding): ModelInput[] {
  return binding.inputs.map((input) => ({
    name: input.name,
    type: input.type,
    required: input.required,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    ...(input.type !== "text" && (input.max ?? 1) > 1 ? { isArray: true } : {}),
  }));
}

function providerModel(binding: RouterBinding): ProviderModel {
  return {
    id: binding.id,
    name: binding.name,
    description: binding.description,
    provider: "comfy",
    capabilities: binding.capabilities,
    pageUrl: `${COMFY_ROUTER_MODELS_URL}#${binding.provider}`,
  };
}

/**
 * The models to offer: every bound model the Router currently serves. When
 * the list cannot be fetched, every bound model is offered and a run of one
 * the Router has retired fails with the Router's own message.
 */
export async function comfyRouterProviderModels(apiKey: string | null): Promise<ProviderModel[]> {
  const live = await listRouterModelIds(apiKey);
  return routerBindings()
    .filter((binding) => !live || live.has(binding.id))
    .map(providerModel);
}

export async function comfyRouterNodeSchema(
  id: string,
  apiKey: string | null
): Promise<{ parameters: ModelParameter[]; inputs: ModelInput[] } | null> {
  const resolved = await resolveRouterModel(id, apiKey);
  if (!resolved) return null;
  return { parameters: nodeParameters(resolved.params, resolved.providers), inputs: nodeInputs(resolved.binding) };
}
