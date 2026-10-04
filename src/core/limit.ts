import { RelayError } from "../shared/errors.js";
import type { Metrics } from "../shared/metrics.js";

export interface LimitConfig {
  maxConcurrentGlobal: number;
  maxConcurrentPerIp: number;
  rateLimitRpm: number;
  rateLimitBurst: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class LimitManager {
  private activeGlobal = 0;
  private activePerIp = new Map<string, number>();
  private ipBuckets = new Map<string, TokenBucket>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: LimitConfig,
    private metrics?: Metrics,
  ) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref();
  }

  get stats() {
    return {
      activeGlobal: this.activeGlobal,
      trackedIps: this.activePerIp.size,
    };
  }

  acquireStreamSlot(ip: string): () => void {
    if (this.activeGlobal >= this.config.maxConcurrentGlobal) {
      if (this.metrics) {
        this.metrics.limits.globalRejections++;
      }
      throw new RelayError(
        "SERVICE_UNAVAILABLE",
        "Relay capacity reached, please retry later",
        503,
      );
    }

    const currentIpActive = this.activePerIp.get(ip) ?? 0;
    if (currentIpActive >= this.config.maxConcurrentPerIp) {
      if (this.metrics) {
        this.metrics.limits.perIpRejections++;
      }
      throw new RelayError(
        "RATE_LIMITED",
        `Maximum concurrent streams per IP (${this.config.maxConcurrentPerIp}) reached`,
        429,
      );
    }

    this.activeGlobal++;
    this.activePerIp.set(ip, currentIpActive + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const remaining = (this.activePerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) {
        this.activePerIp.delete(ip);
      } else {
        this.activePerIp.set(ip, remaining);
      }
    };
  }

  /**
   * Called only on resolve cache MISS.
   * Uses Token Bucket algorithm: fills at (rateLimitRpm / 60) tokens per sec up to burst capacity.
   */
  checkRateLimit(ip: string): void {
    const now = Date.now();
    let bucket = this.ipBuckets.get(ip);

    if (!bucket) {
      bucket = {
        tokens: this.config.rateLimitBurst,
        lastRefill: now,
      };
      this.ipBuckets.set(ip, bucket);
    }

    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    const refillRate = this.config.rateLimitRpm / 60;
    bucket.tokens = Math.min(
      this.config.rateLimitBurst,
      bucket.tokens + elapsedSeconds * refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const waitSeconds = Math.ceil((1 - bucket.tokens) / refillRate);
      if (this.metrics) {
        this.metrics.limits.rateLimitRejections++;
      }
      const err = new RelayError(
        "RATE_LIMITED",
        "Rate limit exceeded for resolver requests",
        429,
      );
      (err as any).retryAfter = waitSeconds;
      throw err;
    }

    bucket.tokens -= 1;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.ipBuckets.entries()) {
      if (
        bucket.tokens >= this.config.rateLimitBurst &&
        now - bucket.lastRefill > 120000
      ) {
        this.ipBuckets.delete(ip);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
