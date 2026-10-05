import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { parseQualityScore } from "../src/routes/internal.js";
import { verifyStreamToken } from "../src/core/token.js";

describe("Batch Resolve Endpoint", () => {
  const secret = "test-secret-key-at-least-32-chars-long";
  const origKey = process.env.INTERNAL_RELAY_KEY;

  beforeEach(() => {
    delete process.env.INTERNAL_RELAY_KEY;
  });

  afterEach(() => {
    if (origKey !== undefined) {
      process.env.INTERNAL_RELAY_KEY = origKey;
    } else {
      delete process.env.INTERNAL_RELAY_KEY;
    }
  });

  it("correctly parses quality scores for sorting", () => {
    expect(parseQualityScore("4k")).toBe(2160);
    expect(parseQualityScore("2160p")).toBe(2160);
    expect(parseQualityScore("2k")).toBe(1440);
    expect(parseQualityScore("1440p")).toBe(1440);
    expect(parseQualityScore("1080p")).toBe(1080);
    expect(parseQualityScore("720p")).toBe(720);
    expect(parseQualityScore("480p")).toBe(480);
    expect(parseQualityScore("unknown")).toBe(0);
  });

  it("validates request body for POST /internal/resolve", async () => {
    const { app } = await createServer({ secret });

    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_BODY");
    await app.close();
  });

  it("enforces authentication when INTERNAL_RELAY_KEY is configured", async () => {
    process.env.INTERNAL_RELAY_KEY = "super-secret-relay-key";
    try {
      const { app } = await createServer({ secret });

      // No auth header -> 401
      const noAuth = await app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { sources: [] },
      });
      expect(noAuth.statusCode).toBe(401);

      // Wrong key -> 401
      const wrongAuth = await app.inject({
        method: "POST",
        url: "/internal/resolve",
        headers: { "x-relay-key": "wrong" },
        payload: { sources: [] },
      });
      expect(wrongAuth.statusCode).toBe(401);

      // Correct X-Relay-Key -> 200
      const okHeader = await app.inject({
        method: "POST",
        url: "/internal/resolve",
        headers: { "x-relay-key": "super-secret-relay-key" },
        payload: { sources: [] },
      });
      expect(okHeader.statusCode).toBe(200);

      // Bearer token -> 200
      const okBearer = await app.inject({
        method: "POST",
        url: "/internal/resolve",
        headers: { authorization: "Bearer super-secret-relay-key" },
        payload: { sources: [] },
      });
      expect(okBearer.statusCode).toBe(200);

      await app.close();
    } finally {
      delete process.env.INTERNAL_RELAY_KEY;
    }
  });

  it("resolves hybrid sources per quality with fallback", async () => {
    const { app, resolver } = await createServer({ secret });

    // Mock resolver.resolve to simulate success and failure per URL
    const resolveSpy = vi.spyOn(resolver, "resolve").mockImplementation(async (targetUrl: string) => {
      if (targetUrl.startsWith("https://acefile.co/f/broken-2160")) {
        throw new Error("Local endpoint 404");
      }
      if (targetUrl.startsWith("https://blogger.com/video.g?token=good-2160")) {
        return {
          directUrl: "https://googlevideo.com/2160",
          ttlMs: 7200000,
        };
      }
      if (targetUrl.startsWith("https://acefile.co/f/good-1080")) {
        return {
          directUrl: "https://acefile.co/service/play/1080",
          ttlMs: 7200000,
        };
      }
      if (targetUrl.startsWith("https://blogger.com/video.g?token=not-reached-1080")) {
        throw new Error("Should not be called because candidate 1 succeeded");
      }
      if (targetUrl.startsWith("https://acefile.co/f/broken-720")) {
        throw new Error("File deleted");
      }
      throw new Error("Unexpected URL: " + targetUrl);
    });

    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      payload: {
        sources: [
          // 720p: will fail all candidates -> omitted from streams
          { site: "acefile", quality: "720p", url: "https://acefile.co/f/broken-720" },
          // 1080p: candidate 1 succeeds -> candidate 2 skipped
          { site: "acefile", quality: "1080p", url: "https://acefile.co/f/good-1080" },
          { site: "blogger", quality: "1080p", url: "https://blogger.com/video.g?token=not-reached-1080" },
          // 2160p: candidate 1 fails -> candidate 2 succeeds
          { site: "acefile", quality: "2160p", url: "https://acefile.co/f/broken-2160" },
          { site: "blogger", quality: "2160p", url: "https://blogger.com/video.g?token=good-2160" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.streams).toHaveLength(2);

    // Sorted descending by quality
    expect(body.streams[0].quality).toBe("2160p");
    expect(body.streams[1].quality).toBe("1080p");

    // Verify stream url format and signature
    const url2160 = new URL(body.streams[0].url, "http://localhost");
    const u2160 = url2160.searchParams.get("u")!;
    const e2160 = url2160.searchParams.get("e")!;
    const s2160 = url2160.searchParams.get("s")!;
    const verified2160 = verifyStreamToken(u2160, e2160, s2160, secret);
    expect(verified2160.targetUrl).toBe("https://blogger.com/video.g?token=good-2160#2160p");

    const url1080 = new URL(body.streams[1].url, "http://localhost");
    const u1080 = url1080.searchParams.get("u")!;
    const e1080 = url1080.searchParams.get("e")!;
    const s1080 = url1080.searchParams.get("s")!;
    const verified1080 = verifyStreamToken(u1080, e1080, s1080, secret);
    expect(verified1080.targetUrl).toBe("https://acefile.co/f/good-1080#1080p");

    // Candidate 2 for 1080p was never called
    expect(resolveSpy).not.toHaveBeenCalledWith("https://blogger.com/video.g?token=not-reached-1080");

    await app.close();
  });

  it("supports /v1/resolve as an alias", async () => {
    const { app } = await createServer({ secret });

    const res = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      payload: { sources: [] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ streams: [] });

    await app.close();
  });
});
