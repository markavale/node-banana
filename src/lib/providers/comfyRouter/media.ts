/**
 * Media for Router requests, server side: decode what the app holds (data
 * URLs, or http URLs of earlier outputs), upload to Comfy storage when a
 * partner takes URLs only, and read a video's length when a partner needs
 * it spelled out.
 */
import { createHash } from "crypto";

import { validateMediaUrl } from "@/utils/urlValidation";
import { COMFY_ROUTER_BASE_URL } from "../comfyRouter";
import type { ComfyMediaValue, MediaEncoding } from "./template";

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;

interface Decoded {
  bytes: Buffer;
  mime: string;
}

export function parseDataUrl(value: string): Decoded | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(value);
  if (!match) return null;
  return { mime: match[1]!, bytes: Buffer.from(match[2]!, "base64") };
}

async function download(url: string): Promise<Decoded> {
  const check = validateMediaUrl(url);
  if (!check.valid) throw new Error(`Invalid media URL: ${check.error}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Could not fetch an input (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("An input is larger than 200MB");
  return { bytes, mime: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
}

/**
 * The length of an MP4/MOV in seconds, from its `mvhd` box; null for other
 * containers or an unreadable file. Enough for partners that need the
 * input's duration spelled out (video upscalers bill by it).
 */
export function mp4Duration(bytes: Buffer): number | null {
  const scan = (start: number, end: number): number | null => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString("latin1", offset + 4, offset + 8);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return null;
        size = Number(bytes.readBigUInt64BE(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return null;
      if (type === "moov") return scan(offset + header, offset + size);
      if (type === "mvhd") {
        const body = offset + header;
        const version = bytes.readUInt8(body);
        const timescale = version === 1 ? bytes.readUInt32BE(body + 20) : bytes.readUInt32BE(body + 12);
        const duration = version === 1 ? Number(bytes.readBigUInt64BE(body + 24)) : bytes.readUInt32BE(body + 16);
        return timescale > 0 ? Math.round((duration / timescale) * 100) / 100 : null;
      }
      offset += size;
    }
    return null;
  };
  try {
    return scan(0, bytes.byteLength);
  } catch {
    return null;
  }
}

const uploads = new Map<string, { url: string; at: number }>();

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

/**
 * Put a file in Comfy storage and return its signed download URL. The same
 * bytes within the hour reuse the first upload.
 */
export async function uploadToComfyStorage(apiKey: string, media: Decoded): Promise<string> {
  const hash = createHash("sha256").update(media.bytes).digest("hex");
  const cached = uploads.get(hash);
  if (cached && Date.now() - cached.at < UPLOAD_TTL_MS) return cached.url;

  const extension = EXTENSIONS[media.mime] ?? media.mime.split("/")[1] ?? "bin";
  const slot = await fetch(`${COMFY_ROUTER_BASE_URL}/customers/storage`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: `node-banana-${hash.slice(0, 16)}.${extension}`, content_type: media.mime }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!slot.ok) throw new Error(`Comfy storage refused the upload (${slot.status})`);
  const { upload_url: uploadUrl, download_url: downloadUrl } = (await slot.json()) as { upload_url?: string; download_url?: string };
  if (!uploadUrl || !downloadUrl) throw new Error("Comfy storage returned no upload URL");

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": media.mime },
    body: new Uint8Array(media.bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!put.ok) throw new Error(`Upload to Comfy storage failed (${put.status})`);
  uploads.set(hash, { url: downloadUrl, at: Date.now() });
  return downloadUrl;
}

/**
 * One value the app holds, encoded the way the handle's partner wants it.
 * `needsDuration` also reads the length of an MP4 input.
 */
export async function encodeMedia(
  value: string,
  encoding: MediaEncoding,
  apiKey: string,
  options: { needsDuration?: boolean } = {}
): Promise<ComfyMediaValue> {
  const isRemote = /^https?:\/\//.test(value);
  let decoded = isRemote ? null : parseDataUrl(value);
  if (!isRemote && !decoded) throw new Error("An input is neither a data URL nor an http URL");

  const out: ComfyMediaValue = {};
  if (isRemote && encoding === "url" && !options.needsDuration) {
    out.url = value;
    return out;
  }
  if (!decoded) decoded = await download(value);

  out.mime = decoded.mime;
  out.base64 = decoded.bytes.toString("base64");
  out.dataUrl = `data:${decoded.mime};base64,${out.base64}`;
  if (options.needsDuration) {
    const seconds = mp4Duration(decoded.bytes);
    if (seconds !== null) out.duration = seconds;
  }
  if (encoding === "url") out.url = isRemote ? value : await uploadToComfyStorage(apiKey, decoded);
  return out;
}
