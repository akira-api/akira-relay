export interface CacheCounters {
  size: number;
  hits: number;
  misses: number;
  negativeHits: number;
  staleHits: number;
  singleFlightJoins: number;
  evictions: number;
}

export interface ResolveCounters {
  ok: number;
  failed: number;
}

export interface StreamCounters {
  active: number;
  started: number;
  finished: number;
  bytesStreamed: number;
}

export interface LimitCounters {
  globalRejections: number;
  perIpRejections: number;
  rateLimitRejections: number;
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

  resolve: ResolveCounters = { ok: 0, failed: 0 };

  streams: StreamCounters = {
    active: 0,
    started: 0,
    finished: 0,
    bytesStreamed: 0,
  };

  limits: LimitCounters = {
    globalRejections: 0,
    perIpRejections: 0,
    rateLimitRejections: 0,
  };

  errorsByCode: Record<string, number> = {};

  countError(code: string): void {
    this.errorsByCode[code] = (this.errorsByCode[code] ?? 0) + 1;
  }
}
