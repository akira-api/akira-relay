import { fetch } from "undici";
import { RelayError } from "../shared/errors.js";
import type { ResolvedStream } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function unpackPacker(html: string): string | null {
  const marker = "eval(function(p,a,c,k,e,d)";
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;
  const snippet = html.slice(startIdx);
  const m = snippet.match(
    /\}\s*\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\.split\('\|'\)/,
  );
  if (!m) return null;

  const p = m[1].slice(1, -1);
  const a = Number.parseInt(m[2], 10);
  const c = Number.parseInt(m[3], 10);
  const k = m[4].slice(1, -1).split("|");

  const baseRadix = (num: number): string => {
    return (
      (num < a ? "" : baseRadix(Math.floor(num / a))) +
      (num % a > 35
        ? String.fromCharCode((num % a) + 29)
        : (num % a).toString(36))
    );
  };

  const dict: Record<string, string> = {};
  for (let i = 0; i < c; i++) {
    const key = baseRadix(i);
    dict[key] = k[i] || key;
  }

  return p.replace(
    /\b\w+\b/g,
    (token) => (dict[token] !== undefined ? dict[token] : token),
  );
}

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
    if (!res.ok) {
      throw new RelayError(
        "VIDEO_UNAVAILABLE",
        `Acefile player returned ${res.status}`,
        410,
        res.status,
      );
    }
    html = await res.text();
  } catch (err: any) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Failed to fetch acefile player page: ${err.message}`,
      410,
    );
  }

  let nfck: string | undefined;
  let duarId: string | undefined;
  let revalidatePath: string | undefined;

  const unpacked = unpackPacker(html);
  if (unpacked) {
    const nfckMatch = unpacked.match(/nfck\s*=\s*["']([a-f0-9]{40})["']/);
    const duarMatch = unpacked.match(/DUAR\s*=\s*(\[[\s\S]*?\]);/);
    if (nfckMatch) nfck = nfckMatch[1];
    if (duarMatch) {
      try {
        const duar = JSON.parse(duarMatch[1]);
        if (Array.isArray(duar) && duar.length > 0) {
          duarId = duar[0].id;
          revalidatePath = duar[0].revalidate;
        }
      } catch {}
    }
  }

  // Fallback to legacy dictionary match if unpack fails
  if (!nfck || !duarId) {
    const dictMatch = html.match(/'([^']+)'\.split\('\|'\)/);
    const dict = dictMatch?.[1]?.split("|") || [];
    if (!nfck) nfck = dict.find((w) => /^[a-f0-9]{40}$/.test(w));
    if (!duarId) duarId = dict.find((w) => /^\d{8,9}$/.test(w) && w !== fileId);
  }

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
        "VIDEO_UNAVAILABLE",
        `Acefile local endpoint failed with status ${localRes.status}`,
        410,
        localRes.status,
      );
    }
    localHtml = await localRes.text();
  } catch (err: any) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Failed to fetch acefile local metadata: ${err.message}`,
      410,
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

  let directUrl: string;
  try {
    const rawJson = Buffer.from(sourceMatch[1], "base64").toString("utf-8");
    const sources = JSON.parse(rawJson) as Array<{ file: string; label?: string; type?: string }>;
    if (!sources || sources.length === 0 || !sources[0]?.file) {
      throw new Error("Empty sources list");
    }

    const file = sources[0].file;
    directUrl = file.startsWith("http") ? file : `https://acefile.co${file}`;
  } catch (err: any) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Failed to parse acefile sources: ${err.message}`,
      410,
    );
  }

  // Probe check: verify stream is playable before returning
  try {
    const probeSignal = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const probeRes = await fetch(directUrl, {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_UA,
        Referer: "https://acefile.co/",
        Range: "bytes=0-1",
      },
      signal: probeSignal,
    });
    if (probeRes.status !== 200 && probeRes.status !== 206) {
      if (revalidatePath) {
        const revalUrl = revalidatePath.startsWith("http")
          ? revalidatePath
          : `https://acefile.co${revalidatePath}`;
        fetch(revalUrl, {
          headers: { "User-Agent": DEFAULT_UA, Referer: "https://acefile.co/" },
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
      throw new RelayError(
        "VIDEO_UNAVAILABLE",
        `Acefile stream probe returned ${probeRes.status}`,
        410,
        probeRes.status,
      );
    }
  } catch (err: any) {
    if (revalidatePath) {
      const revalUrl = revalidatePath.startsWith("http")
        ? revalidatePath
        : `https://acefile.co${revalidatePath}`;
      fetch(revalUrl, {
        headers: { "User-Agent": DEFAULT_UA, Referer: "https://acefile.co/" },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Acefile stream probe failed: ${err.message}`,
      410,
    );
  }

  return {
    directUrl,
    headers: {
      "User-Agent": DEFAULT_UA,
      Referer: "https://acefile.co/",
    },
    ttlMs: 15 * 60 * 1000,
  };
}
