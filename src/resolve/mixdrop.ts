import { fetch } from "undici";
import { RelayError } from "../shared/errors.js";
import type { ResolvedStream } from "./types.js";
import { unpackPacker } from "./acefile.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function extractMixdropSource(html: string): string | null {
  const decoded = unpackPacker(html);
  if (!decoded) return null;
  const match = decoded.match(
    /wurl\s*(?:=|:)\s*["']([^"']+)["']/i,
  );
  return match?.[1] || null;
}

export async function resolveMixdrop(
  url: string,
  timeoutMs = 10000,
): Promise<ResolvedStream> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RelayError("VIDEO_UNAVAILABLE", "Invalid mixdrop URL", 410);
  }

  const res = await fetch(parsed, {
    method: "GET",
    headers: { "User-Agent": DEFAULT_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Mixdrop embed returned ${res.status}`,
      410,
    );
  }

  const source = extractMixdropSource(await res.text());
  if (!source) {
    throw new RelayError("VIDEO_UNAVAILABLE", "Mixdrop source not found", 410);
  }

  const cookie = res.headers.get("set-cookie")?.match(/(?:^|,\s*)([^=;,]+=[^;]*)/)?.[1];
  return {
    directUrl: source.startsWith("//") ? `https:${source}` : source,
    headers: {
      Referer: `${parsed.origin}/`,
      "User-Agent": DEFAULT_UA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ttlMs: 15 * 60 * 1000,
  };
}
