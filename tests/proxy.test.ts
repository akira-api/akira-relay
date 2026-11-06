import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, Socks5ProxyAgent, ProxyAgent } from "undici";
import {
  configureOutboundProxy,
  createServer,
  loadConfigFromEnv,
  sanitizeProxyUrl,
} from "../src/server.js";

describe("Outbound Proxy Configuration", () => {
  const origDispatcher = getGlobalDispatcher();
  const origProxyEnv = process.env.SOCKS5_PROXY;
  const origUseProxyEnv = process.env.USE_PROXY;

  afterEach(() => {
    setGlobalDispatcher(origDispatcher);
    if (origProxyEnv !== undefined) {
      process.env.SOCKS5_PROXY = origProxyEnv;
    } else {
      delete process.env.SOCKS5_PROXY;
    }
    if (origUseProxyEnv !== undefined) {
      process.env.USE_PROXY = origUseProxyEnv;
    } else {
      delete process.env.USE_PROXY;
    }
  });

  it("sanitizes proxy passwords in logs", () => {
    expect(sanitizeProxyUrl("socks5://akira-xray:1080")).toBe(
      "socks5://akira-xray:1080",
    );
    expect(sanitizeProxyUrl("socks5://user:secret123@akira-xray:1080")).toBe(
      "socks5://user:****@akira-xray:1080",
    );
    expect(sanitizeProxyUrl("invalid-url")).toBe("invalid-url");
  });

  it("configures Socks5ProxyAgent for socks5 URLs", () => {
    const agent = configureOutboundProxy("socks5://akira-xray:1080");
    expect(agent).toBeInstanceOf(Socks5ProxyAgent);
    expect(getGlobalDispatcher()).toBe(agent);
  });

  it("configures ProxyAgent for HTTP proxy URLs", () => {
    const agent = configureOutboundProxy("http://127.0.0.1:8080");
    expect(agent).toBeInstanceOf(ProxyAgent);
    expect(getGlobalDispatcher()).toBe(agent);
  });

  it("returns null when no proxy URL is given", () => {
    const agent = configureOutboundProxy(undefined);
    expect(agent).toBeNull();
    expect(getGlobalDispatcher()).toBe(origDispatcher);
  });

  it("throws for unsupported protocols", () => {
    expect(() => configureOutboundProxy("ftp://proxy.com")).toThrow(
      "Unsupported proxy protocol: ftp:",
    );
  });

  it("loads SOCKS5_PROXY and USE_PROXY from environment variables", () => {
    process.env.USE_PROXY = "true";
    process.env.SOCKS5_PROXY = "socks5://akira-xray:1080";
    const config = loadConfigFromEnv();
    expect(config.useProxy).toBe(true);
    expect(config.socks5Proxy).toBe("socks5://akira-xray:1080");
  });

  it("disables proxy when USE_PROXY is false", async () => {
    process.env.USE_PROXY = "false";
    process.env.SOCKS5_PROXY = "socks5://akira-xray:1080";
    const config = loadConfigFromEnv();
    expect(config.useProxy).toBe(false);

    await createServer({
      secret: "test-secret-at-least-32-chars-long",
      useProxy: false,
      socks5Proxy: "socks5://akira-xray:1080",
    });
    expect(getGlobalDispatcher()).toBe(origDispatcher);
  });

  it("enables proxy when USE_PROXY is true", async () => {
    await createServer({
      secret: "test-secret-at-least-32-chars-long",
      useProxy: true,
      socks5Proxy: "socks5://akira-xray:1080",
    });
    expect(getGlobalDispatcher()).toBeInstanceOf(Socks5ProxyAgent);
  });
});
