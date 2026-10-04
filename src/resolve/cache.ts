import { RelayError } from "../shared/errors.js";
import type { Metrics } from "../shared/metrics.js";
import type { ResolvedStream } from "./types.js";

/** Hard cap on cache entries. Oldest (LRU) entry evicted first. */
const MAX_ENTRIES = 1000;

/** How long an expired stream entry stays usable for stale-while-error fallback. */
const STALE_GRACE_MS = 10 * 60 * 1000;

/** How long upstream "video unavailable" verdicts are trusted. */
const NEGATIVE_TTL_MS = 90 * 1000;

interface StreamEntry {
  kind: "stream";
  stream: ResolvedStream;
  freshUntil: number;
  staleUntil: number;
}

interface NegativeEntry {
  kind: "negative";
  error: RelayError;
  freshUntil: number;
}

type CacheEntry = StreamEntry | NegativeEntry;

export type LookupResult =
  | { state: "miss" }
  | { state: "fresh"; stream: ResolvedStream }
  | { state: "stale"; stream: ResolvedStream }
  | { state: "negative"; error: RelayError };

export class ResolveCache {
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<ResolvedStream>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private defaultTtlMs = 15 * 60 * 1000,
    private metrics?: Metrics,
  ) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns fresh/stale/negative/miss and refreshes LRU position on hit. */
  lookup(key: string): LookupResult {
    const entry = this.entries.get(key);
    if (!entry) return { state: "miss" };

    // Reinsert to mark as recently used.
    this.entries.delete(key);

    if (entry.kind === "negative") {
      if (Date.now() < entry.freshUntil) {
        this.entries.set(key, entry);
        return { state: "negative", error: entry.error };
      }
      this.entries.delete(key);
      return { state: "miss" };
    }

    const now = Date.now();
    if (now < entry.freshUntil) {
      this.entries.set(key, entry);
      return { state: "fresh", stream: entry.stream };
    }
    if (now < entry.staleUntil) {
      this.entries.set(key, entry);
      return { state: "stale", stream: entry.stream };
    }
    this.entries.delete(key);
    return { state: "miss" };
  }

  setStream(key: string, stream: ResolvedStream, customTtlMs?: number): void {
    const ttl = customTtlMs ?? stream.ttlMs ?? this.defaultTtlMs;
    const now = Date.now();
    this.entries.delete(key);
    this.entries.set(key, {
      kind: "stream",
      stream,
      freshUntil: now + ttl,
      staleUntil: now + ttl + STALE_GRACE_MS,
    });
    this.evict();
  }

  /** Cache an upstream "video unavailable" verdict so we stop hammering it. */
  setNegative(key: string, error: RelayError, ttlMs = NEGATIVE_TTL_MS): void {
    this.entries.delete(key);
    this.entries.set(key, {
      kind: "negative",
      error,
      freshUntil: Date.now() + ttlMs,
    });
    this.evict();
  }

  /**
   * Single-flight: concurrent callers for the same key share one resolver
   * promise. Failures are NOT cached here — callers decide (negative vs stale).
   */
  async begin(
    key: string,
    resolver: () => Promise<ResolvedStream>,
  ): Promise<ResolvedStream> {
    const existing = this.inFlight.get(key);
    if (existing) {
      if (this.metrics) {
        this.metrics.cache.singleFlightJoins++;
      }
      return existing;
    }

    const promise = (async () => {
      try {
        return await resolver();
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Evict least-recently-used entries until under the hard cap. */
  private evict(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      if (this.metrics) {
        this.metrics.cache.evictions++;
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      const expired =
        entry.kind === "negative"
          ? now >= entry.freshUntil
          : now >= entry.staleUntil;
      if (expired) {
        this.entries.delete(key);
      }
    }
    if (this.metrics) {
      this.metrics.cache.size = this.entries.size;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
