import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { computeHmac, signStreamUrl, toBase64Url } from "../src/core/token.js";

describe("Fastify Stream API", () => {
  const secret = "test-secret-key-at-least-32-chars-long";

  it("responds to /internal/health", async () => {
    const { app } = await createServer({ secret });
    const res = await app.inject({
      method: "GET",
      url: "/internal/health",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    await app.close();
  });

  it("handles CORS OPTIONS preflight", async () => {
    const { app } = await createServer({ secret });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/stream",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    await app.close();
  });

  it("returns 400 for missing token params", async () => {
    const { app } = await createServer({ secret });
    const res = await app.inject({
      method: "GET",
      url: "/v1/stream",
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_TOKEN");
    await app.close();
  });

  it("returns 403 for expired tokens", async () => {
    const { app } = await createServer({ secret });
    const u = toBase64Url("https://acefile.co/f/12345");
    const pastTime = Math.floor(Date.now() / 1000) - 60;
    const s = computeHmac(u, pastTime, secret);

    const res = await app.inject({
      method: "GET",
      url: `/v1/stream?u=${u}&e=${pastTime}&s=${s}`,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("TOKEN_EXPIRED");
    await app.close();
  });

  it("returns 403 for forbidden target host", async () => {
    const { app } = await createServer({
      secret,
      allowedHosts: ["acefile.co"],
    });
    const { path } = signStreamUrl(
      "https://malicious-site.com/video.mp4",
      secret,
      3600,
    );

    const res = await app.inject({
      method: "GET",
      url: path,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("FORBIDDEN_TARGET");
    await app.close();
  });

  it("exposes stats via /internal/stats", async () => {
    const prevKey = process.env.INTERNAL_RELAY_KEY;
    delete process.env.INTERNAL_RELAY_KEY;
    try {
      const { app } = await createServer({ secret });
      const res = await app.inject({
        method: "GET",
        url: "/internal/stats",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("uptimeSec");
      expect(body).toHaveProperty("memory");
      expect(body.cache).toHaveProperty("hits");
      expect(body.cache).toHaveProperty("misses");
      expect(body.cache).toHaveProperty("negativeHits");
      expect(body.cache).toHaveProperty("staleHits");
      expect(body.streams).toHaveProperty("bytesStreamed");
      expect(body.limits).toHaveProperty("rateLimitRejections");
      expect(body).toHaveProperty("errorsByCode");
      expect(body).toHaveProperty("errorsByProvider");

      // Detailed bandwidth & throughput metrics
      expect(body.bandwidth).toHaveProperty("currentSpeedMbps");
      expect(body.bandwidth).toHaveProperty("totalStreamedMB");
      expect(body.bandwidth).toHaveProperty("totalStreamedGB");

      // Cache hit ratio
      expect(body.cache).toHaveProperty("hitRatioPercent");

      // Per-provider & per-resolution breakdowns
      expect(body.resolve).toHaveProperty("byProvider");
      expect(body.resolve).toHaveProperty("byResolution");
      expect(body.streams).toHaveProperty("byProvider");
      expect(body.streams).toHaveProperty("byResolution");

      await app.close();
    } finally {
      if (prevKey !== undefined) {
        process.env.INTERNAL_RELAY_KEY = prevKey;
      }
    }
  });

  it("rejects stats without X-Relay-Key when key is configured", async () => {
    process.env.INTERNAL_RELAY_KEY = "dashboard-secret";
    try {
      const { app } = await createServer({ secret });

      const denied = await app.inject({
        method: "GET",
        url: "/internal/stats",
      });
      expect(denied.statusCode).toBe(401);

      const allowed = await app.inject({
        method: "GET",
        url: "/internal/stats",
        headers: { "x-relay-key": "dashboard-secret" },
      });
      expect(allowed.statusCode).toBe(200);
      await app.close();
    } finally {
      delete process.env.INTERNAL_RELAY_KEY;
    }
  });

  it("accurately records per-provider, resolution, and bandwidth metrics", async () => {
    const { app, metrics } = await createServer({ secret });

    // Simulate resolve
    metrics.recordResolve("acefile", "1080p", true);
    metrics.recordResolve("acefile", "720p", false);
    metrics.recordResolve("blogger", "480p", true);

    // Simulate streaming
    metrics.recordStreamStart("acefile", "1080p");
    metrics.recordStreamBytes(1048576 * 5, "acefile"); // 5 MB
    metrics.recordStreamEnd("acefile");

    metrics.countError("404", "acefile");

    const res = await app.inject({
      method: "GET",
      url: "/internal/stats",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.resolve.byProvider.acefile).toEqual({ total: 2, ok: 1, failed: 1 });
    expect(body.resolve.byProvider.blogger).toEqual({ total: 1, ok: 1, failed: 0 });
    expect(body.resolve.byResolution["1080p"]).toBe(1);
    expect(body.resolve.byResolution["480p"]).toBe(1);

    expect(body.streams.byProvider.acefile.bytesStreamedMB).toBe(5);
    expect(body.streams.byResolution["1080p"]).toBe(1);

    expect(body.bandwidth.totalStreamedMB).toBe(5);
    expect(body.bandwidth.currentSpeedMbps).toBeGreaterThan(0);

    expect(body.errorsByProvider.acefile["404"]).toBe(1);

    await app.close();
  });
});
