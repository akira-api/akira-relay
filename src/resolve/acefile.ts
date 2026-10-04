import { fetch } from "undici";
import { RelayError } from "../shared/errors.js";
import type { ResolvedStream } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function normalizeAcefileUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.match(/\/(?:player|f)\/(\d+)\b/)?.[1];
    return id ? `https://acefile.co/f/${id}` : url;
  } catch {
    return url;
  }
}

export async function resolveAcefile(
  url: string,
  timeoutMs = 10000,
): Promise<ResolvedStream> {
  const fileId = url.match(/\/(?:f|player)\/(\d+)/)?.[1];
  if (!fileId) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "Invalid acefile URL: file ID not found",
      410,
    );
  }

  const signal = AbortSignal.timeout(timeoutMs);

  let html: string;
  try {
    const res = await fetch(`https://acefile.co/player/${fileId}`, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_UA },
      signal,
    });
    if (res.status === 404 || res.status === 410) {
      throw new RelayError(
        "VIDEO_UNAVAILABLE",
        `Acefile player returned ${res.status}`,
        410,
        res.status,
      );
    }
    if (!res.ok) {
      throw new RelayError(
        "UPSTREAM_ERROR",
        `Acefile player request failed with status ${res.status}`,
        502,
        res.status,
      );
    }
    html = await res.text();
  } catch (err: any) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "UPSTREAM_ERROR",
      `Failed to fetch acefile player page: ${err.message}`,
      502,
    );
  }

  const dictMatch = html.match(/'([^']+)'\.split\('\|'\)/);
  const dict = dictMatch?.[1]?.split("|") || [];
  if (!dict.length) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "Acefile packed script not found or video removed",
      410,
    );
  }

  const nfck = dict.find((w) => /^[a-f0-9]{40}$/.test(w));
  const duarId = dict.find((w) => /^\d{8,9}$/.test(w) && w !== fileId);
  if (!nfck || !duarId) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "Acefile mirror keys not found",
      410,
    );
  }

  let localHtml: string;
  try {
    const localRes = await fetch(
      `https://acefile.co/local/${duarId}?key=${nfck}`,
      {
        method: "GET",
        headers: { "User-Agent": DEFAULT_UA, Referer: "https://acefile.co/" },
        signal,
      },
    );
    if (!localRes.ok) {
      throw new RelayError(
        "UPSTREAM_ERROR",
        `Acefile local endpoint failed with status ${localRes.status}`,
        502,
        localRes.status,
      );
    }
    localHtml = await localRes.text();
  } catch (err: any) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "UPSTREAM_ERROR",
      `Failed to fetch acefile local metadata: ${err.message}`,
      502,
    );
  }

  const sourceMatch = localHtml.match(/atob\("([^"]+)"\)/);
  if (!sourceMatch) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "Acefile video source data not found",
      410,
    );
  }

  try {
    const rawJson = Buffer.from(sourceMatch[1], "base64").toString("utf-8");
    const sources = JSON.parse(rawJson) as Array<{ file: string; label?: string; type?: string }>;
    if (!sources || sources.length === 0 || !sources[0]?.file) {
      throw new Error("Empty sources list");
    }

    const file = sources[0].file;
    const directUrl = file.startsWith("http") ? file : `https://acefile.co${file}`;

    return {
      directUrl,
      headers: {
        "User-Agent": DEFAULT_UA,
        Referer: "https://acefile.co/",
      },
      // acefile service URLs are stable per file; 1 hour avoids repeated
      // player-page + local-endpoint fetches for the same id.
      ttlMs: 60 * 60 * 1000,
    };
  } catch (err: any) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Failed to parse acefile sources: ${err.message}`,
      410,
    );
  }
}
