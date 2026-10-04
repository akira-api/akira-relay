import type { FastifyPluginAsync } from "fastify";
import type { LimitManager } from "../core/limit.js";
import type { StreamResolver } from "../resolve/index.js";
import type { Metrics } from "../shared/metrics.js";

export interface InternalRouteOptions {
  resolver: StreamResolver;
  limits: LimitManager;
  metrics: Metrics;
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

  // Stats endpoint for the Akira dashboard. Auth: X-Relay-Key required only
  // when INTERNAL_RELAY_KEY is configured.
  fastify.get("/internal/stats", async (req, reply) => {
    const requiredKey = process.env.INTERNAL_RELAY_KEY;
    if (requiredKey) {
      const provided = req.headers["x-relay-key"];
      if (provided !== requiredKey) {
        return reply.status(401).send({
          error: { code: "INVALID_TOKEN", message: "Invalid or missing X-Relay-Key" },
        });
      }
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

  /*
   * Phase 2 Endpoints (Optional / Reserved):
   *
   * fastify.post("/internal/resolve", async (req, reply) => {
   *   const key = req.headers["x-relay-key"];
   *   if (key !== process.env.INTERNAL_RELAY_KEY) return reply.status(401).send();
   *   ...
   * });
   */
};
