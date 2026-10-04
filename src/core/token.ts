import { createHmac, timingSafeEqual } from "node:crypto";
import { RelayError } from "../shared/errors.js";

export function toBase64Url(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64url");
}

export function fromBase64Url(b64url: string): string {
  try {
    return Buffer.from(b64url, "base64url").toString("utf-8");
  } catch {
    throw new RelayError("INVALID_TOKEN", "Malformed base64url target", 400);
  }
}

export function computeHmac(u: string, e: number | string, secret: string): string {
  return createHmac("sha256", secret).update(`${u}.${e}`).digest("hex");
}

export function signStreamUrl(
  targetUrl: string,
  secret: string,
  ttlSeconds = 7200,
): { u: string; e: number; s: string; path: string } {
  const u = toBase64Url(targetUrl);
  const e = Math.floor(Date.now() / 1000) + ttlSeconds;
  const s = computeHmac(u, e, secret);
  const path = `/v1/stream?u=${encodeURIComponent(u)}&e=${e}&s=${s}`;
  return { u, e, s, path };
}

export function verifyStreamToken(
  u: string | undefined,
  eStr: string | undefined,
  s: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { targetUrl: string; expiry: number } {
  if (!u || !eStr || !s) {
    throw new RelayError("INVALID_TOKEN", "Missing required token parameters (u, e, s)", 400);
  }

  const e = Number.parseInt(eStr, 10);
  if (Number.isNaN(e)) {
    throw new RelayError("INVALID_TOKEN", "Expiry parameter must be an integer", 400);
  }

  const expectedSig = computeHmac(u, e, secret);
  const expectedBuf = Buffer.from(expectedSig, "hex");
  const providedBuf = Buffer.from(s, "hex");

  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new RelayError("INVALID_TOKEN", "Invalid signature", 403);
  }

  if (e < nowSeconds) {
    throw new RelayError("TOKEN_EXPIRED", "Stream token has expired", 403);
  }

  const targetUrl = fromBase64Url(u);
  try {
    const parsed = new URL(targetUrl);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error();
    }
  } catch {
    throw new RelayError("INVALID_TOKEN", "Target URL is not a valid HTTP/HTTPS URL", 400);
  }

  return { targetUrl, expiry: e };
}
