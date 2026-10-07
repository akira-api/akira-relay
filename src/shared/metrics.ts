export function detectProvider(urlOrHost: string): string {
  try {
    let hostname = urlOrHost;
    if (urlOrHost.includes("://")) {
      hostname = new URL(urlOrHost).hostname;
    } else if (urlOrHost.includes("/")) {
      hostname = urlOrHost.split("/")[0];
    }
    const lower = hostname.toLowerCase();
    if (lower.includes("acefile.co")) return "acefile";
    if (lower.includes("blogger.com")) return "blogger";
    return lower || "unknown";
  } catch {
    return "unknown";
  }
}

export function detectResolution(url: string): string {
  try {
    const hash = new URL(url).hash.replace(/^#/, "").trim();
    if (hash) return hash.toLowerCase();
  } catch {}
  return "unknown";
}

export interface CacheCounters {
  size: number;
  hits: number;
  misses: number;
  negativeHits: number;
  staleHits: number;
  singleFlightJoins: number;
  evictions: number;
}

export interface ProviderResolveStats {
  total: number;
  ok: number;
  failed: number;
}

export interface ProviderStreamStats {
  active: number;
  started: number;
  finished: number;
  bytesStreamed: number;
  bytesStreamedMB: number;
}

export interface ResolveCounters {
  ok: number;
  failed: number;
  byProvider: Record<string, ProviderResolveStats>;
  byResolution: Record<string, number>;
}

export interface StreamCounters {
  active: number;
  started: number;
  finished: number;
  bytesStreamed: number;
  byProvider: Record<string, ProviderStreamStats>;
  byResolution: Record<string, number>;
}

export interface BandwidthStats {
  currentSpeedMbps: number;
  totalStreamedMB: number;
  totalStreamedGB: number;
}

export interface LimitCounters {
  globalRejections: number;
  perIpRejections: number;
  rateLimitRejections: number;
}

interface SecondBucket {
  second: number;
  bytes: number;
}

export class Metrics {
  cache: CacheCounters = {
    size: 0,
    hits: 0,
    misses: 0,
    negativeHits: 0,
    staleHits: 0,
    singleFlightJoins: 0,
    evictions: 0,
  };

  resolve: ResolveCounters = {
    ok: 0,
    failed: 0,
    byProvider: {},
    byResolution: {},
  };

  streams: StreamCounters = {
    active: 0,
    started: 0,
    finished: 0,
    bytesStreamed: 0,
    byProvider: {},
    byResolution: {},
  };

  limits: LimitCounters = {
    globalRejections: 0,
    perIpRejections: 0,
    rateLimitRejections: 0,
  };

  errorsByCode: Record<string, number> = {};
  errorsByProvider: Record<string, Record<string, number>> = {};

  private rollingBuckets: SecondBucket[] = [];

  private getOrCreateResolveProvider(provider: string): ProviderResolveStats {
    if (!this.resolve.byProvider[provider]) {
      this.resolve.byProvider[provider] = { total: 0, ok: 0, failed: 0 };
    }
    return this.resolve.byProvider[provider];
  }

  private getOrCreateStreamProvider(provider: string): ProviderStreamStats {
    if (!this.streams.byProvider[provider]) {
      this.streams.byProvider[provider] = {
        active: 0,
        started: 0,
        finished: 0,
        bytesStreamed: 0,
        bytesStreamedMB: 0,
      };
    }
    return this.streams.byProvider[provider];
  }

  recordResolve(provider: string, resolution?: string, ok = true): void {
    if (ok) {
      this.resolve.ok++;
    } else {
      this.resolve.failed++;
    }

    const p = this.getOrCreateResolveProvider(provider);
    p.total++;
    if (ok) {
      p.ok++;
    } else {
      p.failed++;
    }

    if (resolution) {
      const resKey = resolution.toLowerCase().trim();
      if (resKey) {
        this.resolve.byResolution[resKey] =
          (this.resolve.byResolution[resKey] || 0) + (ok ? 1 : 0);
      }
    }
  }

  recordStreamStart(provider: string, resolution?: string): void {
    this.streams.active++;
    this.streams.started++;

    const p = this.getOrCreateStreamProvider(provider);
    p.active++;
    p.started++;

    if (resolution) {
      const resKey = resolution.toLowerCase().trim();
      if (resKey) {
        this.streams.byResolution[resKey] =
          (this.streams.byResolution[resKey] || 0) + 1;
      }
    }
  }

  recordStreamEnd(provider: string): void {
    this.streams.active = Math.max(0, this.streams.active - 1);
    this.streams.finished++;

    const p = this.getOrCreateStreamProvider(provider);
    p.active = Math.max(0, p.active - 1);
    p.finished++;
  }

  recordStreamBytes(bytes: number, provider?: string): void {
    this.streams.bytesStreamed += bytes;

    const currentSec = Math.floor(Date.now() / 1000);
    const last = this.rollingBuckets[this.rollingBuckets.length - 1];
    if (last && last.second === currentSec) {
      last.bytes += bytes;
    } else {
      this.rollingBuckets.push({ second: currentSec, bytes });
      const cutoff = currentSec - 10;
      this.rollingBuckets = this.rollingBuckets.filter((b) => b.second >= cutoff);
    }

    if (provider) {
      const p = this.getOrCreateStreamProvider(provider);
      p.bytesStreamed += bytes;
      p.bytesStreamedMB =
        Math.round((p.bytesStreamed / (1024 * 1024)) * 100) / 100;
    }
  }

  countError(code: string, provider?: string): void {
    this.errorsByCode[code] = (this.errorsByCode[code] ?? 0) + 1;
    if (provider) {
      if (!this.errorsByProvider[provider]) {
        this.errorsByProvider[provider] = {};
      }
      this.errorsByProvider[provider][code] =
        (this.errorsByProvider[provider][code] ?? 0) + 1;
    }
  }

  getCurrentSpeedMbps(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - 5;
    const active = this.rollingBuckets.filter(
      (b) => b.second >= cutoff && b.second <= nowSec,
    );
    const totalBytes = active.reduce((sum, b) => sum + b.bytes, 0);
    const windowSec = 5;
    const speedBps = (totalBytes * 8) / windowSec;
    return Math.round((speedBps / (1024 * 1024)) * 100) / 100;
  }

  getBandwidthStats(): BandwidthStats {
    const bytes = this.streams.bytesStreamed;
    return {
      currentSpeedMbps: this.getCurrentSpeedMbps(),
      totalStreamedMB: Math.round((bytes / (1024 * 1024)) * 100) / 100,
      totalStreamedGB: Math.round((bytes / (1024 * 1024 * 1024)) * 1000) / 1000,
    };
  }

  getCacheStats(): CacheCounters & { hitRatioPercent: number } {
    const totalLookups = this.cache.hits + this.cache.misses;
    const hitRatioPercent =
      totalLookups > 0
        ? Math.round((this.cache.hits / totalLookups) * 10000) / 100
        : 0;
    return {
      ...this.cache,
      hitRatioPercent,
    };
  }
}
