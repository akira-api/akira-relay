import { describe, expect, it } from "vitest";
import { LimitManager } from "../src/core/limit.js";
import { RelayError } from "../src/shared/errors.js";

describe("LimitManager", () => {
  it("enforces global max concurrency", () => {
    const limits = new LimitManager({
      maxConcurrentGlobal: 2,
      maxConcurrentPerIp: 5,
      rateLimitRpm: 60,
      rateLimitBurst: 10,
    });

    const release1 = limits.acquireStreamSlot("1.1.1.1");
    const release2 = limits.acquireStreamSlot("1.1.1.2");

    expect(() => limits.acquireStreamSlot("1.1.1.3")).toThrow(RelayError);

    release1();
    // After releasing one slot, acquisition should succeed
    const release3 = limits.acquireStreamSlot("1.1.1.3");
    expect(release3).toBeDefined();

    release2();
    release3();
    limits.destroy();
  });

  it("enforces per-IP concurrency", () => {
    const limits = new LimitManager({
      maxConcurrentGlobal: 10,
      maxConcurrentPerIp: 2,
      rateLimitRpm: 60,
      rateLimitBurst: 10,
    });

    const r1 = limits.acquireStreamSlot("10.0.0.1");
    const r2 = limits.acquireStreamSlot("10.0.0.1");

    expect(() => limits.acquireStreamSlot("10.0.0.1")).toThrow(RelayError);
    // Other IP is unaffected
    const rOther = limits.acquireStreamSlot("10.0.0.2");
    expect(rOther).toBeDefined();

    r1();
    const r3 = limits.acquireStreamSlot("10.0.0.1");
    expect(r3).toBeDefined();

    r2();
    r3();
    rOther();
    limits.destroy();
  });

  it("enforces rate limits on token exhaustion", () => {
    const limits = new LimitManager({
      maxConcurrentGlobal: 100,
      maxConcurrentPerIp: 10,
      rateLimitRpm: 60,
      rateLimitBurst: 3,
    });

    const ip = "192.168.1.10";
    limits.checkRateLimit(ip);
    limits.checkRateLimit(ip);
    limits.checkRateLimit(ip);

    // 4th request exceeds burst capacity
    expect(() => limits.checkRateLimit(ip)).toThrow(RelayError);

    limits.destroy();
  });
});
