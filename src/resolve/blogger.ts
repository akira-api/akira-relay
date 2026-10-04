import { fetch } from "undici";
import { RelayError } from "../shared/errors.js";
import type { ResolvedStream } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ITAG_PRIORITY: Record<string, number> = {
  "37": 1080,
  "22": 720,
  "18": 360,
  "7": 240,
  "13": 144,
};

export function extractBloggerToken(input: string): string | null {
  try {
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      return url.searchParams.get("token") || null;
    }
    return input.trim() || null;
  } catch {
    return null;
  }
}

export function normalizeBloggerUrl(input: string): string {
  const token = extractBloggerToken(input);
  return token ? `https://www.blogger.com/video.g?token=${token}` : input;
}

export async function resolveBlogger(
  input: string,
  timeoutMs = 10000,
): Promise<ResolvedStream> {
  const token = extractBloggerToken(input);
  if (!token) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "No valid blogger video token found",
      410,
    );
  }

  const signal = AbortSignal.timeout(timeoutMs);

  let page: string;
  try {
    const pageRes = await fetch(`https://www.blogger.com/video.g?token=${token}`, {
      headers: { "User-Agent": DEFAULT_UA },
      signal,
    });
    if (pageRes.status === 404 || pageRes.status === 410) {
      throw new RelayError(
        "VIDEO_UNAVAILABLE",
        `Blogger player returned ${pageRes.status}`,
        410,
        pageRes.status,
      );
    }
    if (!pageRes.ok) {
      throw new RelayError(
        "UPSTREAM_ERROR",
        `Blogger player page failed with status ${pageRes.status}`,
        502,
        pageRes.status,
      );
    }
    page = await pageRes.text();
  } catch (err: any) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "UPSTREAM_ERROR",
      `Failed to fetch blogger player page: ${err.message}`,
      502,
    );
  }

  const sid = page.split('FdrFJe":"')[1]?.split('"')[0];
  const bl = page.split('cfb2h":"')[1]?.split('"')[0];
  if (!sid || !bl) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "Blogger session keys not found",
      410,
    );
  }

  const reqid = Math.floor(Date.now() / 1000) % 86400;
  const rpcUrl =
    "https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute" +
    `?rpcids=WcwnYd&source-path=/video.g&f.sid=${sid}` +
    `&bl=${bl}&hl=en-US&_reqid=${reqid}&rt=c`;
  const fReq = `[[["WcwnYd","[\\"${token}\\",null,0]",null,"generic"]]]`;

  let rpc: string;
  try {
    const rpcRes = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.blogger.com/",
      },
      body: new URLSearchParams({ "f.req": fReq }),
      signal,
    });
    if (!rpcRes.ok) {
      throw new RelayError(
        "UPSTREAM_ERROR",
        `Blogger RPC failed with status ${rpcRes.status}`,
        502,
        rpcRes.status,
      );
    }
    rpc = await rpcRes.text();
  } catch (err: any) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(
      "UPSTREAM_ERROR",
      `Failed to call blogger batchexecute RPC: ${err.message}`,
      502,
    );
  }

  if (!rpc.includes("videoplayback")) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "Blogger returned no playable streams for this video",
      410,
    );
  }

  const rawUrls = [...rpc.matchAll(/https?:[^"]*videoplayback[^"]*/g)].map(
    (m) => m[0],
  );

  const streams: Array<{ url: string; score: number }> = [];
  for (const raw of rawUrls) {
    const directUrl = raw
      .replace(/\\+$/, "")
      .replace(/\\+u003d/g, "=")
      .replace(/\\+u0026/g, "&")
      .replace(/\\+u002f/g, "/");
    const itag = directUrl.match(/itag=(\d+)/)?.[1];
    if (!itag || streams.some((s) => s.url === directUrl)) continue;

    const score = ITAG_PRIORITY[itag] ?? 100;
    streams.push({ url: directUrl, score });
  }

  if (streams.length === 0) {
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      "No valid video streams parsed from blogger RPC",
      410,
    );
  }

  streams.sort((a, b) => b.score - a.score);

  return {
    directUrl: streams[0].url,
    headers: {
      "User-Agent": DEFAULT_UA,
      Referer: "https://www.blogger.com/",
    },
    ttlMs: 20 * 60 * 1000,
  };
}
