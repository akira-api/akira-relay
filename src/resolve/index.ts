import { RelayError } from "../shared/errors.js";
import type { Metrics } from "../shared/metrics.js";
import { normalizeAcefileUrl, resolveAcefile } from "./acefile.js";
import { normalizeBloggerUrl, resolveBlogger } from "./blogger.js";
import { ResolveCache } from "./cache.js";
import type { ResolvedStream } from "./types.js";

export function isHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const lowerHost = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const cleanAllowed = allowed.trim().toLowerCase();
    if (!cleanAllowed) return false;
    return lowerHost === cleanAllowed || lowerHost.endsWith(`.${cleanAllowed}`);
  });
}

export function normalizeTargetUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    if (host.includes("acefile.co")) {
      return normalizeAcefileUrl(urlStr);
    }
    if (host.includes("blogger.com")) {
      return normalizeBloggerUrl(urlStr);
    }
    return urlStr;
  } catch {
    return urlStr;
  }
}

export class StreamResolver {
  private cache: ResolveCache;
  private allowedHosts: string[];
  private resolveTimeoutMs: number;
  private metrics?: Metrics;

  constructor(options: {
    cacheTtlMs?: number;
    allowedHosts?: string[];
    resolveTimeoutMs?: number;
    metrics?: Metrics;
  }) {
    this.metrics = options.metrics;
    this.cache = new ResolveCache(
      options.cacheTtlMs ?? 15 * 60 * 1000,
      options.metrics,
    );
    this.allowedHosts = options.allowedHosts ?? [
      "acefile.co",
      "blogger.com",
      "googleusercontent.com",
      "googlevideo.com",
    ];
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? 10000;
  }

  async resolve(
    targetUrl: string,
    onUpstreamFetch?: () => void,
  ): Promise<ResolvedStream> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new RelayError("INVALID_TOKEN", "Malformed target URL", 400);
    }

    if (!isHostAllowed(parsed.hostname, this.allowedHosts)) {
      throw new RelayError(
        "FORBIDDEN_TARGET",
        `Target host '${parsed.hostname}' is not permitted`,
        403,
      );
    }

    const key = normalizeTargetUrl(targetUrl);
    const lookup = this.cache.lookup(key);

    if (lookup.state === "fresh") {
      if (this.metrics) {
        this.metrics.cache.hits++;
      }
      return lookup.stream;
    }

    if (lookup.state === "negative") {
      if (this.metrics) {
        this.metrics.cache.negativeHits++;
      }
      throw lookup.error;
    }

    const staleStream = lookup.state === "stale" ? lookup.stream : undefined;

    // Only a real upstream fetch consumes rate limit budget; joining an
    // in-flight resolve does not.
    if (!this.cache.hasInFlight(key) && onUpstreamFetch) {
      onUpstreamFetch();
    }

    if (this.metrics) {
      this.metrics.cache.misses++;
    }

    try {
      const stream = await this.cache.begin(key, () =>
        this.fetchDirect(targetUrl, key, parsed.hostname),
      );
      if (this.metrics) {
        this.metrics.resolve.ok++;
      }
      return stream;
    } catch (err: any) {
      if (this.metrics) {
        this.metrics.resolve.failed++;
      }

      // Negative cache: trust "video unavailable" verdicts for a short window.
      if (err instanceof RelayError && err.code === "VIDEO_UNAVAILABLE") {
        this.cache.setNegative(key, err);
      }

      // Stale-while-error: expired entry within grace period beats a 5xx.
      if (
        staleStream &&
        !(err instanceof RelayError && err.code === "VIDEO_UNAVAILABLE")
      ) {
        if (this.metrics) {
          this.metrics.cache.staleHits++;
        }
        return staleStream;
      }

      throw err;
    }
  }

  private async fetchDirect(
    targetUrl: string,
    key: string,
    hostname: string,
  ): Promise<ResolvedStream> {
    const host = hostname.toLowerCase();

    let stream: ResolvedStream;
    if (host.includes("acefile.co")) {
      stream = await resolveAcefile(key, this.resolveTimeoutMs);
    } else if (host.includes("blogger.com")) {
      stream = await resolveBlogger(key, this.resolveTimeoutMs);
    } else {
      // Direct/passthrough video stream (e.g. googlevideo or direct mp4/m3u8)
      stream = {
        directUrl: targetUrl,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        ttlMs: 30 * 60 * 1000,
      };
    }

    this.cache.setStream(key, stream);
    if (this.metrics) {
      this.metrics.cache.size = this.cache.size;
    }
    return stream;
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  destroy(): void {
    this.cache.destroy();
  }
}
