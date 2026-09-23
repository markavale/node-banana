/**
 * Comfy Router constants.
 *
 * Comfy Router (https://api.comfy.org/v2/models/{provider}/{model}) fronts
 * two hundred partner models behind one Comfy key and forwards each
 * partner's native request and response. The catalog, the wire formats and
 * the schema-driven settings live in ./comfyRouter/ (families.json,
 * template.ts, schema.ts, catalog.ts); this file keeps the endpoints the
 * rest of the app links to.
 */
export const COMFY_ROUTER_BASE_URL = "https://api.comfy.org";
export const COMFY_ROUTER_KEYS_URL = "https://platform.comfy.org/profile/api-keys?onboarding=router";
export const COMFY_ROUTER_MODELS_URL = "https://docs.comfy.org/development/comfy-router/models";
