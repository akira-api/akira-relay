import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { LimitManager } from "../core/limit.js";
import { pipeVideoToClient } from "../core/relay.js";
import { verifyStreamToken } from "../core/token.js";
import type { StreamResolver } from "../resolve/index.js";
import { RelayError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import {
  detectProvider,
  detectResolution,
  type Metrics,
} from "../shared/metrics.js";

export interface StreamRouteOptions {
  secret: string;
  resolver: StreamResolver;
  limits: LimitManager;
  metrics?: Metrics;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export function getClientIp(req: FastifyRequest): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim().length > 0) {
    return cfIp.trim();
  }
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "127.0.0.1";
}

export const streamRoute: FastifyPluginAsync<StreamRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.get<{
    Querystring: {
      u?: string;
      e?: string;
      s?: string;
    };
  }>("/v1/stream", async (req, reply) => {
    let safeRelease: (() => void) | null = null;
    let targetUrl: string | undefined;

    try {
      const { u, e, s } = req.query;

      // 1. Verify token
      const verified = verifyStreamToken(u, e, s, opts.secret);
      targetUrl = verified.targetUrl;

      const clientIp = getClientIp(req);
      const provider = detectProvider(targetUrl);
      const resolution = detectResolution(targetUrl);

      // 2. Concurrency limit acquisition
      const releaseSlot = opts.limits.acquireStreamSlot(clientIp);
      let slotReleased = false;
      safeRelease = () => {
        if (!slotReleased) {
          slotReleased = true;
          releaseSlot();
          if (opts.metrics) {
            opts.metrics.recordStreamEnd(provider);
          }
        }
      };
      reply.raw.on("finish", safeRelease);
      reply.raw.on("close", safeRelease);

      if (opts.metrics) {
        opts.metrics.recordStreamStart(provider, resolution);
      }

      // 3. Resolve target URL (Rate limit checked only on cache miss)
      const stream = await opts.resolver.resolve(targetUrl, () => {
        opts.limits.checkRateLimit(clientIp);
      });

      // 4. Stream video with auto backpressure + auto-destroy
      await pipeVideoToClient({
        req,
        reply,
        stream,
        metrics: opts.metrics,
        provider,
        idleTimeoutMs: opts.idleTimeoutMs,
        connectTimeoutMs: opts.connectTimeoutMs,
      });
    } catch (err: any) {
      if (safeRelease) {
        safeRelease();
      }

      // Auto-evict cached stream on upstream failures (403, 404, 410, timeout)
      if (targetUrl) {
        opts.resolver.evict(targetUrl);
      }

      if (opts.metrics) {
        const provider = req.query?.u ? detectProvider(req.query.u) : undefined;
        opts.metrics.countError(
          err instanceof RelayError ? err.code : "UPSTREAM_ERROR",
          provider,
        );
      }
      logger.warn(`Stream request failed: ${err.message || err}`);
      if (!reply.raw.headersSent) {
        if (err instanceof RelayError) {
          if ((err as any).retryAfter) {
            reply.header("Retry-After", String((err as any).retryAfter));
          }
          return reply.status(err.statusCode).send(err.toPayload());
        }
        return reply.status(502).send({
          error: {
            code: "UPSTREAM_ERROR",
            message: err.message || "Unknown streaming error",
          },
        });
      }
      // If headers were already sent, destroy socket
      reply.raw.destroy(err);
    }
  });
};
