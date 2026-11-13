import Database, { type Database as BetterSqliteDatabase, type Statement } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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
    if (lower.includes("mixdrop")) return "mixdrop";
    if (lower.includes("mp4upload") || lower === "mp4") return "mp4";
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
  retentionDays?: number;
}

export interface MetricsOptions {
  dbPath?: string;
  retentionDays?: number;
}

export function getCutoffDate(retentionDays = 30): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - retentionDays);
  return d.toISOString().slice(0, 10);
}

export function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
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

  readonly retentionDays: number;
  private db: BetterSqliteDatabase | null = null;
  private stmtUpsert: Statement | null = null;
  private stmtSumRecent: Statement | null = null;
  private stmtSumByProvider: Statement | null = null;
  private stmtPrune: Statement | null = null;
  private pendingBytes = new Map<string, number>();
  private flushInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private rollingBuckets: SecondBucket[] = [];

  constructor(options?: MetricsOptions) {
    this.retentionDays = options?.retentionDays ?? 30;

    const resolvedPath =
      options?.dbPath ??
      (process.env.NODE_ENV === "test"
        ? ":memory:"
        : process.env.SQLITE_DB_PATH || "./data/relay.db");

    this.initDatabase(resolvedPath);
  }

  private initDatabase(resolvedPath: string): void {
    if (resolvedPath !== ":memory:") {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(resolvedPath);
    if (resolvedPath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("synchronous = NORMAL");

    this.initSchema();
    this.prepareStatements();
    this.syncFromDb();

    this.flushInterval = setInterval(() => this.flush(), 5000);
    this.flushInterval.unref();

    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bandwidth_daily (
        date TEXT NOT NULL,
        provider TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, provider)
      );
      CREATE INDEX IF NOT EXISTS idx_bandwidth_date ON bandwidth_daily(date);
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO bandwidth_daily (date, provider, bytes)
      VALUES (?, ?, ?)
      ON CONFLICT(date, provider) DO UPDATE SET bytes = bytes + excluded.bytes
    `);
    this.stmtSumRecent = this.db.prepare(`
      SELECT SUM(bytes) as total_bytes
      FROM bandwidth_daily
      WHERE date >= ?
    `);
    this.stmtSumByProvider = this.db.prepare(`
      SELECT provider, SUM(bytes) as total_bytes
      FROM bandwidth_daily
      WHERE date >= ?
      GROUP BY provider
    `);
    this.stmtPrune = this.db.prepare(`
      DELETE FROM bandwidth_daily
      WHERE date < ?
    `);
  }

  syncFromDb(): void {
    if (!this.db || !this.stmtSumRecent || !this.stmtSumByProvider || !this.stmtPrune) {
      return;
    }

    const cutoff = getCutoffDate(this.retentionDays);
    this.stmtPrune.run(cutoff);

    const totalRow = this.stmtSumRecent.get(cutoff) as
      | { total_bytes: number | null }
      | undefined;
    this.streams.bytesStreamed = Number(totalRow?.total_bytes ?? 0);

    for (const key of Object.keys(this.streams.byProvider)) {
      this.streams.byProvider[key].bytesStreamed = 0;
      this.streams.byProvider[key].bytesStreamedMB = 0;
    }

    const providerRows = this.stmtSumByProvider.all(cutoff) as Array<{
      provider: string;
      total_bytes: number | null;
    }>;

    for (const row of providerRows) {
      const p = this.getOrCreateStreamProvider(row.provider);
      p.bytesStreamed = Number(row.total_bytes ?? 0);
      p.bytesStreamedMB =
        Math.round((p.bytesStreamed / (1024 * 1024)) * 100) / 100;
    }
  }

  cleanup(): void {
    this.flush();
    this.syncFromDb();
  }

  flush(): void {
    if (!this.db || !this.stmtUpsert || this.pendingBytes.size === 0) {
      return;
    }

    const entries = Array.from(this.pendingBytes.entries());
    this.pendingBytes.clear();

    const insertMany = this.db.transaction((items: [string, number][]) => {
      for (const [key, bytes] of items) {
        const sepIndex = key.indexOf("::");
        const date = key.slice(0, sepIndex);
        const provider = key.slice(sepIndex + 2);
        this.stmtUpsert!.run(date, provider, bytes);
      }
    });

    try {
      insertMany(entries);
    } catch {
      for (const [key, bytes] of entries) {
        this.pendingBytes.set(key, (this.pendingBytes.get(key) || 0) + bytes);
      }
    }
  }

  resetBandwidth(): void {
    this.pendingBytes.clear();
    if (this.db) {
      this.db.prepare("DELETE FROM bandwidth_daily").run();
    }
    this.streams.bytesStreamed = 0;
    for (const key of Object.keys(this.streams.byProvider)) {
      this.streams.byProvider[key].bytesStreamed = 0;
      this.streams.byProvider[key].bytesStreamedMB = 0;
    }
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.flush();
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

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

    if (this.db) {
      const today = getTodayDate();
      const prov = provider || "unknown";
      const key = `${today}::${prov}`;
      this.pendingBytes.set(key, (this.pendingBytes.get(key) || 0) + bytes);
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
      retentionDays: this.retentionDays,
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
