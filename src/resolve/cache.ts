import Database, { type Database as BetterSqliteDatabase, type Statement } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { RelayError, type RelayErrorCode } from "../shared/errors.js";
import type { Metrics } from "../shared/metrics.js";
import type { ResolvedStream } from "./types.js";

/** Hard cap on cache entries. Oldest accessed entries evicted first. */
const MAX_ENTRIES = 1000;

/** How long an expired stream entry stays usable for stale-while-error fallback. */
const STALE_GRACE_MS = 10 * 60 * 1000;

/** How long upstream "video unavailable" verdicts are trusted. */
const NEGATIVE_TTL_MS = 90 * 1000;

export type LookupResult =
  | { state: "miss" }
  | { state: "fresh"; stream: ResolvedStream }
  | { state: "stale"; stream: ResolvedStream }
  | { state: "negative"; error: RelayError };

export class ResolveCache {
  private db: BetterSqliteDatabase;
  private inFlight = new Map<string, Promise<ResolvedStream>>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private maxEntries: number;

  private stmtGetNegative!: Statement;
  private stmtGetStream!: Statement;
  private stmtUpsertStream!: Statement;
  private stmtUpsertNegative!: Statement;
  private stmtDeleteNegative!: Statement;
  private stmtDeleteStream!: Statement;
  private stmtUpdateStreamAccess!: Statement;
  private stmtUpdateNegativeAccess!: Statement;
  private stmtCountStream!: Statement;
  private stmtEvictOldest!: Statement;
  private stmtCleanupStream!: Statement;
  private stmtCleanupNegative!: Statement;

  constructor(
    private defaultTtlMs = 2 * 60 * 60 * 1000,
    private metrics?: Metrics,
    dbPath?: string,
    maxEntries = MAX_ENTRIES,
  ) {
    this.maxEntries = maxEntries;

    const resolvedPath =
      dbPath ??
      (process.env.NODE_ENV === "test"
        ? ":memory:"
        : process.env.SQLITE_DB_PATH || "./data/relay.db");

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

    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resolve_cache (
        key TEXT PRIMARY KEY,
        direct_url TEXT NOT NULL,
        headers TEXT,
        ttl_ms INTEGER NOT NULL,
        fresh_until INTEGER NOT NULL,
        stale_until INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS negative_cache (
        key TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        fresh_until INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_resolve_accessed ON resolve_cache(accessed_at);
      CREATE INDEX IF NOT EXISTS idx_resolve_stale ON resolve_cache(stale_until);
      CREATE INDEX IF NOT EXISTS idx_negative_fresh ON negative_cache(fresh_until);
    `);
  }

  private prepareStatements(): void {
    this.stmtGetNegative = this.db.prepare(
      "SELECT code, message, status_code, fresh_until FROM negative_cache WHERE key = ?",
    );
    this.stmtGetStream = this.db.prepare(
      "SELECT direct_url, headers, ttl_ms, fresh_until, stale_until FROM resolve_cache WHERE key = ?",
    );
    this.stmtUpsertStream = this.db.prepare(`
      INSERT INTO resolve_cache (key, direct_url, headers, ttl_ms, fresh_until, stale_until, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        direct_url = excluded.direct_url,
        headers = excluded.headers,
        ttl_ms = excluded.ttl_ms,
        fresh_until = excluded.fresh_until,
        stale_until = excluded.stale_until,
        accessed_at = excluded.accessed_at
    `);
    this.stmtUpsertNegative = this.db.prepare(`
      INSERT INTO negative_cache (key, code, message, status_code, fresh_until, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        code = excluded.code,
        message = excluded.message,
        status_code = excluded.status_code,
        fresh_until = excluded.fresh_until,
        accessed_at = excluded.accessed_at
    `);
    this.stmtDeleteNegative = this.db.prepare(
      "DELETE FROM negative_cache WHERE key = ?",
    );
    this.stmtDeleteStream = this.db.prepare(
      "DELETE FROM resolve_cache WHERE key = ?",
    );
    this.stmtUpdateStreamAccess = this.db.prepare(
      "UPDATE resolve_cache SET accessed_at = ? WHERE key = ?",
    );
    this.stmtUpdateNegativeAccess = this.db.prepare(
      "UPDATE negative_cache SET accessed_at = ? WHERE key = ?",
    );
    this.stmtCountStream = this.db.prepare(
      "SELECT COUNT(*) AS c FROM resolve_cache",
    );
    this.stmtEvictOldest = this.db.prepare(
      "DELETE FROM resolve_cache WHERE key IN (SELECT key FROM resolve_cache ORDER BY accessed_at ASC LIMIT ?)",
    );
    this.stmtCleanupStream = this.db.prepare(
      "DELETE FROM resolve_cache WHERE stale_until <= ?",
    );
    this.stmtCleanupNegative = this.db.prepare(
      "DELETE FROM negative_cache WHERE fresh_until <= ?",
    );
  }

  get size(): number {
    const row = this.stmtCountStream.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Returns fresh/stale/negative/miss and updates accessed_at on hit. */
  lookup(key: string): LookupResult {
    const now = Date.now();

    const neg = this.stmtGetNegative.get(key) as
      | { code: string; message: string; status_code: number; fresh_until: number }
      | undefined;
    if (neg) {
      if (now < neg.fresh_until) {
        this.stmtUpdateNegativeAccess.run(now, key);
        return {
          state: "negative",
          error: new RelayError(
            neg.code as RelayErrorCode,
            neg.message,
            neg.status_code,
          ),
        };
      }
      this.stmtDeleteNegative.run(key);
    }

    const row = this.stmtGetStream.get(key) as
      | {
          direct_url: string;
          headers: string | null;
          ttl_ms: number;
          fresh_until: number;
          stale_until: number;
        }
      | undefined;

    if (!row) return { state: "miss" };

    const stream: ResolvedStream = {
      directUrl: row.direct_url,
      headers: row.headers ? JSON.parse(row.headers) : undefined,
      ttlMs: row.ttl_ms,
    };

    if (now < row.fresh_until) {
      this.stmtUpdateStreamAccess.run(now, key);
      return { state: "fresh", stream };
    }

    if (now < row.stale_until) {
      this.stmtUpdateStreamAccess.run(now, key);
      return { state: "stale", stream };
    }

    this.stmtDeleteStream.run(key);
    return { state: "miss" };
  }

  setStream(key: string, stream: ResolvedStream, customTtlMs?: number): void {
    const ttl = customTtlMs ?? stream.ttlMs ?? this.defaultTtlMs;
    const now = Date.now();
    const freshUntil = now + ttl;
    const staleUntil = now + ttl + STALE_GRACE_MS;
    const headersStr = stream.headers ? JSON.stringify(stream.headers) : null;

    this.stmtDeleteNegative.run(key);
    this.stmtUpsertStream.run(
      key,
      stream.directUrl,
      headersStr,
      ttl,
      freshUntil,
      staleUntil,
      now,
    );
    this.evict();
  }

  /** Cache an upstream "video unavailable" verdict so we stop hammering it. */
  setNegative(key: string, error: RelayError, ttlMs = NEGATIVE_TTL_MS): void {
    const now = Date.now();
    this.stmtDeleteStream.run(key);
    this.stmtUpsertNegative.run(
      key,
      error.code,
      error.message,
      error.statusCode,
      now + ttlMs,
      now,
    );
  }

  /** Explicitly delete a stream key from cache (used on upstream 403/410 errors). */
  evictKey(key: string): void {
    this.stmtDeleteStream.run(key);
    this.stmtDeleteNegative.run(key);
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
    const currentSize = this.size;
    if (currentSize > this.maxEntries) {
      const excess = currentSize - this.maxEntries;
      this.stmtEvictOldest.run(excess);
      if (this.metrics) {
        this.metrics.cache.evictions += excess;
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    this.stmtCleanupStream.run(now);
    this.stmtCleanupNegative.run(now);
    if (this.metrics) {
      this.metrics.cache.size = this.size;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
