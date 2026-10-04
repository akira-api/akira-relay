import { describe, expect, it } from "vitest";
import {
  computeHmac,
  fromBase64Url,
  signStreamUrl,
  toBase64Url,
  verifyStreamToken,
} from "../src/core/token.js";
import { RelayError } from "../src/shared/errors.js";

describe("token helper", () => {
  const secret = "test-relay-secret-key-32-chars-long";
  const url = "https://acefile.co/f/33519262";

  it("encodes and decodes base64url correctly", () => {
    const encoded = toBase64Url(url);
    expect(fromBase64Url(encoded)).toBe(url);
  });

  it("signs and successfully verifies valid token", () => {
    const { u, e, s } = signStreamUrl(url, secret, 3600);
    const result = verifyStreamToken(u, String(e), s, secret);
    expect(result.targetUrl).toBe(url);
    expect(result.expiry).toBe(e);
  });

  it("fails verification if signature is tampered", () => {
    const { u, e } = signStreamUrl(url, secret, 3600);
    const tamperedSig = "a".repeat(64);
    expect(() =>
      verifyStreamToken(u, String(e), tamperedSig, secret),
    ).toThrow(RelayError);
    try {
      verifyStreamToken(u, String(e), tamperedSig, secret);
    } catch (err) {
      expect((err as RelayError).code).toBe("INVALID_TOKEN");
      expect((err as RelayError).statusCode).toBe(403);
    }
  });

  it("fails verification if target URL is tampered", () => {
    const { e, s } = signStreamUrl(url, secret, 3600);
    const tamperedU = toBase64Url("https://acefile.co/f/99999999");
    expect(() =>
      verifyStreamToken(tamperedU, String(e), s, secret),
    ).toThrow(RelayError);
  });

  it("rejects expired token", () => {
    const u = toBase64Url(url);
    const pastTime = Math.floor(Date.now() / 1000) - 100;
    const s = computeHmac(u, pastTime, secret);

    expect(() =>
      verifyStreamToken(u, String(pastTime), s, secret),
    ).toThrow(RelayError);
    try {
      verifyStreamToken(u, String(pastTime), s, secret);
    } catch (err) {
      expect((err as RelayError).code).toBe("TOKEN_EXPIRED");
      expect((err as RelayError).statusCode).toBe(403);
    }
  });

  it("rejects missing parameters", () => {
    expect(() =>
      verifyStreamToken(undefined, "123", "abc", secret),
    ).toThrow(RelayError);
  });

  it("rejects non-http URLs", () => {
    const badUrl = "javascript:alert(1)";
    const { u, e, s } = signStreamUrl(badUrl, secret, 3600);
    expect(() => verifyStreamToken(u, String(e), s, secret)).toThrow(RelayError);
  });
});
