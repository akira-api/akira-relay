export interface ResolvedStream {
  directUrl: string;
  headers?: Record<string, string>;
  ttlMs?: number;
}
