import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { LimitManager } from "../core/limit.js";
import { signStreamUrl } from "../core/token.js";
import type { StreamResolver } from "../resolve/index.js";
import { logger } from "../shared/logger.js";
import type { Metrics } from "../shared/metrics.js";

export interface InternalRouteOptions {
  resolver: StreamResolver;
  limits: LimitManager;
  metrics: Metrics;
  secret: string;
  internalRelayKey?: string;
}

export interface SourceCandidate {
  site?: string;
  quality: string;
  url: string;
}

export interface ResolveRequestBody {
  sources?: SourceCandidate[];
}

export function parseQualityScore(quality: string): number {
  const clean = quality.toLowerCase().trim();
  if (clean === "4k" || clean === "2160p") return 2160;
  if (clean === "2k" || clean === "1440p") return 1440;
  const match = clean.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function checkAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  requiredKey?: string,
): boolean {
  if (!requiredKey) return true;
  const headerKey = req.headers["x-relay-key"];
  const authHeader = req.headers.authorization;
  let bearerKey: string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    bearerKey = authHeader.slice(7).trim();
  }
  const provided = (typeof headerKey === "string" ? headerKey : undefined) || bearerKey;
  if (provided !== requiredKey) {
    reply.status(401).send({
      error: { code: "INVALID_TOKEN", message: "Invalid or missing X-Relay-Key" },
    });
    return false;
  }
  return true;
}

export const internalRoutes: FastifyPluginAsync<InternalRouteOptions> = async (
  fastify,
  opts,
) => {
  const { resolver, limits, metrics } = opts;

  // Healthcheck endpoint for Docker / orchestration
  fastify.get("/internal/health", async () => {
    return { status: "ok", timestamp: Date.now() };
  });

  // Stats endpoint for the Akira dashboard.
  fastify.get("/internal/stats", async (req, reply) => {
    const requiredKey =
      opts.internalRelayKey !== undefined
        ? opts.internalRelayKey
        : process.env.INTERNAL_RELAY_KEY;
    if (!checkAuth(req, reply, requiredKey)) {
      return;
    }

    metrics.cache.size = resolver.getCacheSize();

    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
      },
      cache: metrics.cache,
      resolve: metrics.resolve,
      streams: metrics.streams,
      limits: {
        ...limits.stats,
        ...metrics.limits,
      },
      errorsByCode: metrics.errorsByCode,
    };
  });

  // Batch / Hybrid Resolve Endpoint for Akira
  const resolveHandler = async (
    req: FastifyRequest<{ Body: ResolveRequestBody }>,
    reply: FastifyReply,
  ) => {
    const requiredKey =
      opts.internalRelayKey !== undefined
        ? opts.internalRelayKey
        : process.env.INTERNAL_RELAY_KEY;
    if (!checkAuth(req, reply, requiredKey)) {
      return;
    }

    const { sources } = req.body || {};
    if (!Array.isArray(sources)) {
      return reply.status(400).send({
        error: { code: "INVALID_BODY", message: "Body must contain 'sources' array" },
      });
    }

    // Group candidates by quality
    const groups = new Map<string, SourceCandidate[]>();
    for (const item of sources) {
      if (!item || typeof item.url !== "string" || typeof item.quality !== "string") {
        continue;
      }
      const q = item.quality.trim();
      if (!q) continue;
      const list = groups.get(q) ?? [];
      list.push(item);
      groups.set(q, list);
    }

    // Sort qualities descending (highest resolution first)
    const sortedQualities = Array.from(groups.keys()).sort(
      (a, b) => parseQualityScore(b) - parseQualityScore(a),
    );

    // Hybrid resolve: parallel across qualities, sequential fallback within each quality
    const results = await Promise.all(
      sortedQualities.map(async (quality) => {
        const candidates = groups.get(quality)!;
        for (const candidate of candidates) {
          try {
            const streamTarget = `${candidate.url}#${quality.toLowerCase()}`;
            await resolver.resolve(streamTarget, undefined, quality);
            const { path } = signStreamUrl(streamTarget, opts.secret, 7200);
            return {
              quality,
              url: path,
            };
          } catch (err: any) {
            logger.warn(
              `Candidate failed for ${quality} [${candidate.site || "unknown"}] (${candidate.url}): ${err?.message || err}`,
            );
            continue;
          }
        }
        return null;
      }),
    );

    const streams = results.filter(
      (r): r is { quality: string; url: string } => r !== null,
    );

    return { streams };
  };

  fastify.post("/internal/resolve", resolveHandler);
  fastify.post("/v1/resolve", resolveHandler);
};
