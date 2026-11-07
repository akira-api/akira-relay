import cors from "@fastify/cors";
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ProxyAgent,
  setGlobalDispatcher,
  Socks5ProxyAgent,
  type Dispatcher,
} from "undici";
import { LimitManager } from "./core/limit.js";
import {
  createGatewayAgent,
  sanitizeGatewayUrl,
} from "./core/transport.js";
import { StreamResolver } from "./resolve/index.js";
import { internalRoutes } from "./routes/internal.js";
import { getClientIp, streamRoute } from "./routes/stream.js";
import { RelayError } from "./shared/errors.js";
import { logger } from "./shared/logger.js";
import { Metrics } from "./shared/metrics.js";

export interface ServerConfig {
  port?: number;
  secret: string;
  allowedHosts?: string[];
  maxConcurrentGlobal?: number;
  maxConcurrentPerIp?: number;
  rateLimitRpm?: number;
  rateLimitBurst?: number;
  resolveCacheTtlMs?: number;
  idleTimeoutMs?: number;
  resolveTimeoutMs?: number;
  connectTimeoutMs?: number;
  sqliteDbPath?: string;
  internalRelayKey?: string;
  useProxy?: boolean;
  socks5Proxy?: string;
  gatewayUrl?: string;
  gatewayKey?: string;
}

export function sanitizeProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function configureOutboundProxy(proxyUrl?: string): Dispatcher | null {
  if (!proxyUrl) return null;
  const parsed = new URL(proxyUrl);
  let agent: Dispatcher;
  if (parsed.protocol.startsWith("socks")) {
    agent = new Socks5ProxyAgent(proxyUrl);
  } else if (parsed.protocol.startsWith("http")) {
    agent = new ProxyAgent(proxyUrl);
  } else {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  setGlobalDispatcher(agent);
  return agent;
}

export function loadConfigFromEnv(): ServerConfig {
  const secret = process.env.RELAY_SECRET;
  if (!secret && process.env.NODE_ENV !== "test") {
    throw new Error("RELAY_SECRET environment variable is required");
  }

  const allowedHosts = process.env.ALLOWLIST_HOSTS
    ? process.env.ALLOWLIST_HOSTS.split(",").map((s) => s.trim())
    : [
        "acefile.co",
        "blogger.com",
        "miiiixdrop.net",
        "googleusercontent.com",
        "googlevideo.com",
        "mp4upload.com",
      ];

  return {
    port: Number.parseInt(process.env.PORT || "3000", 10),
    secret: secret || "default-dev-secret-minimum-32-characters-long",
    allowedHosts,
    maxConcurrentGlobal: Number.parseInt(
      process.env.MAX_CONCURRENT_STREAMS || "150",
      10,
    ),
    maxConcurrentPerIp: Number.parseInt(
      process.env.PER_IP_CONCURRENT_STREAMS || "8",
      10,
    ),
    rateLimitRpm: Number.parseInt(process.env.RATE_LIMIT_RPM || "60", 10),
    rateLimitBurst: Number.parseInt(process.env.RATE_LIMIT_BURST || "30", 10),
    resolveCacheTtlMs: Number.parseInt(
      process.env.RESOLVE_CACHE_TTL_MS || "7200000",
      10,
    ),
    idleTimeoutMs: Number.parseInt(process.env.IDLE_TIMEOUT_MS || "20000", 10),
    resolveTimeoutMs: Number.parseInt(
      process.env.RESOLVE_TIMEOUT_MS || "10000",
      10,
    ),
    connectTimeoutMs: Number.parseInt(
      process.env.CONNECT_TIMEOUT_MS || "25000",
      10,
    ),
    sqliteDbPath: process.env.SQLITE_DB_PATH || "./data/relay.db",
    internalRelayKey: process.env.INTERNAL_RELAY_KEY,
    useProxy:
      process.env.USE_PROXY?.toLowerCase() === "true" ||
      process.env.USE_PROXY === "1",
    socks5Proxy: process.env.SOCKS5_PROXY || process.env.ALL_PROXY,
    gatewayUrl: process.env.GATEWAY_URL,
    gatewayKey: process.env.GATEWAY_KEY,
  };
}

export async function createServer(
  config: ServerConfig,
): Promise<{
  app: FastifyInstance;
  resolver: StreamResolver;
  limits: LimitManager;
  metrics: Metrics;
}> {
  if (config.gatewayUrl && config.gatewayKey) {
    const agent = createGatewayAgent({
      gatewayUrl: config.gatewayUrl,
      gatewayKey: config.gatewayKey,
    });
    setGlobalDispatcher(agent);
    logger.info(
      `Outbound gateway transport enabled: ${sanitizeGatewayUrl(config.gatewayUrl)}`,
    );
  } else if (config.useProxy && config.socks5Proxy) {
    configureOutboundProxy(config.socks5Proxy);
    logger.info(
      `Outbound proxy configured: ${sanitizeProxyUrl(config.socks5Proxy)}`,
    );
  }

  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  const metrics = new Metrics();

  if (process.env.NODE_ENV !== "test") {
    const isSilentPath = (url: string) =>
      url === "/internal/health" || url === "/internal/stats";

    app.addHook("onRequest", async (req) => {
      (req.raw as any).__startTime = Date.now();
    });

    app.addHook("onResponse", async (req, reply) => {
      if (isSilentPath(req.url)) return;
      const startTime = (req.raw as any).__startTime || Date.now();
      const duration = Date.now() - startTime;
      logger.http(req.method, req.url, reply.statusCode, duration, getClientIp(req));
    });
  }

  await app.register(cors, {
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["Range", "Authorization", "Content-Type", "Origin", "Accept"],
    exposedHeaders: [
      "Content-Range",
      "Content-Length",
      "Accept-Ranges",
      "Content-Type",
      "Retry-After",
    ],
  });

  const limits = new LimitManager(
    {
      maxConcurrentGlobal: config.maxConcurrentGlobal ?? 150,
      maxConcurrentPerIp: config.maxConcurrentPerIp ?? 8,
      rateLimitRpm: config.rateLimitRpm ?? 60,
      rateLimitBurst: config.rateLimitBurst ?? 30,
    },
    metrics,
  );

  const resolver = new StreamResolver({
    cacheTtlMs: config.resolveCacheTtlMs,
    allowedHosts: config.allowedHosts,
    resolveTimeoutMs: config.resolveTimeoutMs,
    dbPath: config.sqliteDbPath,
    metrics,
  });

  app.setErrorHandler((error: Error, _req, reply) => {
    if (error instanceof RelayError) {
      if ((error as any).retryAfter) {
        reply.header("Retry-After", String((error as any).retryAfter));
      }
      return reply.status(error.statusCode).send(error.toPayload());
    }
    return reply.status(500).send({
      error: {
        code: "UPSTREAM_ERROR",
        message: error.message || "Internal server error",
      },
    });
  });

  // Healthcheck, stats, and batch resolve endpoints
  await app.register(internalRoutes, {
    resolver,
    limits,
    metrics,
    secret: config.secret,
    internalRelayKey: config.internalRelayKey,
  });

  await app.register(streamRoute, {
    secret: config.secret,
    resolver,
    limits,
    metrics,
    idleTimeoutMs: config.idleTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs ?? 25000,
  });

  app.addHook("onClose", async () => {
    limits.destroy();
    resolver.destroy();
  });

  return { app, resolver, limits, metrics };
}

async function start() {
  const config = loadConfigFromEnv();
  const { app } = await createServer(config);

  try {
    const address = await app.listen({ port: config.port ?? 3000, host: "0.0.0.0" });
    logger.info(`Akira relay listening at ${address}`);
  } catch (err: any) {
    logger.error("Failed to start server:", err?.message || err);
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));

if (isDirectRun) {
  start();
}
