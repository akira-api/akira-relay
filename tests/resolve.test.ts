import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { unpackPacker } from "../src/resolve/acefile.js";
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

  it("rejects recursive relay stream target URLs", async () => {
    const resolver = new StreamResolver({
      allowedHosts: ["acefile.co", "akira-relay.navierr.dev"],
    });

    await expect(
      resolver.resolve("https://akira-relay.navierr.dev/v1/stream?u=abc&s=123"),
    ).rejects.toThrow(RelayError);

    try {
      await resolver.resolve("https://akira-relay.navierr.dev/v1/stream?u=abc&s=123");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_TOKEN");
      expect(err.statusCode).toBe(400);
    }

    resolver.destroy();
  });

  it("persists entries across cache instances using SQLite file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akira-cache-test-"));
    const dbPath = path.join(tmpDir, "test.db");

    try {
      const cache1 = new ResolveCache(7200000, undefined, dbPath);
      cache1.setStream("test-url-1", {
        directUrl: "https://cdn.example.com/disk.mp4",
        ttlMs: 7200000,
      });
      cache1.destroy();

      // Open new instance on same file
      const cache2 = new ResolveCache(7200000, undefined, dbPath);
      const lookup = cache2.lookup("test-url-1");
      expect(lookup.state).toBe("fresh");
      if (lookup.state === "fresh") {
        expect(lookup.stream.directUrl).toBe("https://cdn.example.com/disk.mp4");
      }
      cache2.destroy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("evicts cached keys explicitly on failure", () => {
    const cache = new ResolveCache(7200000);
    cache.setStream("test-evict-key", {
      directUrl: "https://cdn.example.com/stream.mp4",
      ttlMs: 7200000,
    });
    expect(cache.lookup("test-evict-key").state).toBe("fresh");

    cache.evictKey("test-evict-key");
    expect(cache.lookup("test-evict-key").state).toBe("miss");
    cache.destroy();
  });

  it("unpacks Dean Edwards packer script format correctly", () => {
    const sampleHtml = `<script>eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}('var nfck="458cbc2ff92bd124640d5f01989e6080f5f0fae8";var DUAR=[{"id":"112287004"}];',2,2,'nfck|DUAR'.split('|'),0,{}))</script>`;
    const unpacked = unpackPacker(sampleHtml);
    expect(unpacked).toContain('var nfck="458cbc2ff92bd124640d5f01989e6080f5f0fae8"');
    expect(unpacked).toContain('var DUAR=[{"id":"112287004"}]');
  });
});
