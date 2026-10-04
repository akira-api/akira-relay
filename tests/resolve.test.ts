import { describe, expect, it, vi } from "vitest";
import { ResolveCache } from "../src/resolve/cache.js";
import {
  isHostAllowed,
  normalizeTargetUrl,
  StreamResolver,
} from "../src/resolve/index.js";
import { RelayError } from "../src/shared/errors.js";

describe("Resolve & Cache", () => {
  it("validates host allowlist correctly", () => {
    const allowed = ["acefile.co", "blogger.com", "googlevideo.com"];
    expect(isHostAllowed("acefile.co", allowed)).toBe(true);
    expect(isHostAllowed("sub.acefile.co", allowed)).toBe(true);
    expect(isHostAllowed("blogger.com", allowed)).toBe(true);
    expect(isHostAllowed("r1---sn-xxx.googlevideo.com", allowed)).toBe(true);
    expect(isHostAllowed("evil.com", allowed)).toBe(false);
    expect(isHostAllowed("notacefile.co.evil.com", allowed)).toBe(false);
  });

  it("normalizes acefile URLs", () => {
    expect(
      normalizeTargetUrl("https://acefile.co/player/33519262"),
    ).toBe("https://acefile.co/f/33519262");
    expect(
      normalizeTargetUrl("https://acefile.co/f/33519262/cosmetic-slug"),
    ).toBe("https://acefile.co/f/33519262");
  });

  it("deduplicates simultaneous in-flight resolutions (single-flight)", async () => {
    const cache = new ResolveCache(10000);
    const mockResolver = vi.fn(async () => {
      // Simulate network delay
      await new Promise((r) => setTimeout(r, 50));
      return {
        directUrl: "https://cdn.example.com/video.mp4",
        ttlMs: 5000,
      };
    });

    const [res1, res2] = await Promise.all([
      cache.begin("url-1", mockResolver),
      cache.begin("url-1", mockResolver),
    ]);

    expect(mockResolver).toHaveBeenCalledTimes(1);
    expect(res1.directUrl).toBe("https://cdn.example.com/video.mp4");
    expect(res2.directUrl).toBe("https://cdn.example.com/video.mp4");
    cache.destroy();
  });

  it("negative-caches VIDEO_UNAVAILABLE for a short window", () => {
    const cache = new ResolveCache(10000);
    const err = new RelayError("VIDEO_UNAVAILABLE", "gone", 410);
    cache.setNegative("k1", err);

    const lookup = cache.lookup("k1");
    expect(lookup.state).toBe("negative");
    if (lookup.state === "negative") {
      expect(lookup.error.code).toBe("VIDEO_UNAVAILABLE");
      expect(lookup.error.statusCode).toBe(410);
    }
    cache.destroy();
  });

  it("serves stale entry after upstream failure (stale-while-error)", async () => {
    const cache = new ResolveCache(1); // 1ms TTL -> immediately stale
    cache.setStream("k2", {
      directUrl: "https://cdn.example.com/old.mp4",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));

    const lookup = cache.lookup("k2");
    expect(lookup.state).toBe("stale");
    if (lookup.state === "stale") {
      expect(lookup.stream.directUrl).toBe("https://cdn.example.com/old.mp4");
    }
    cache.destroy();
  });

  it("evicts least-recently-used entries beyond 1000 (LRU cap)", () => {
    const cache = new ResolveCache(60000);
    for (let i = 0; i < 1100; i++) {
      cache.setStream(`key-${i}`, {
        directUrl: `https://cdn.example.com/${i}.mp4`,
        ttlMs: 60000,
      });
    }

    expect(cache.size).toBe(1000);
    // Oldest evicted, newest kept
    expect(cache.lookup("key-0").state).toBe("miss");
    expect(cache.lookup("key-1099").state).toBe("fresh");
    cache.destroy();
  });

  it("rejects forbidden target host", async () => {
    const resolver = new StreamResolver({
      allowedHosts: ["acefile.co"],
    });

    await expect(
      resolver.resolve("https://unauthorized-domain.com/video.mp4"),
    ).rejects.toThrow(RelayError);

    try {
      await resolver.resolve("https://unauthorized-domain.com/video.mp4");
    } catch (err: any) {
      expect(err.code).toBe("FORBIDDEN_TARGET");
      expect(err.statusCode).toBe(403);
    }

    resolver.destroy();
  });
});
