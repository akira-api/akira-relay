import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createServer, loadConfigFromEnv } from "../src/server.js";
import {
  buildTransportHeader,
  createGatewayAgent,
  createGatewayConnector,
  sanitizeGatewayUrl,
} from "../src/core/transport.js";

describe("Gateway Transport Configuration", () => {
  const origDispatcher = getGlobalDispatcher();
  const origGatewayEnabled = process.env.GATEWAY_ENABLED;
  const origGatewayUrl = process.env.GATEWAY_URL;
  const origGatewayKey = process.env.GATEWAY_KEY;
  const origGatewayDomains = process.env.GATEWAY_DOMAINS;

  afterEach(() => {
    setGlobalDispatcher(origDispatcher);
    if (origGatewayEnabled !== undefined) {
      process.env.GATEWAY_ENABLED = origGatewayEnabled;
    } else {
      delete process.env.GATEWAY_ENABLED;
    }
    if (origGatewayUrl !== undefined) {
      process.env.GATEWAY_URL = origGatewayUrl;
    } else {
      delete process.env.GATEWAY_URL;
    }
    if (origGatewayKey !== undefined) {
      process.env.GATEWAY_KEY = origGatewayKey;
    } else {
      delete process.env.GATEWAY_KEY;
    }
    if (origGatewayDomains !== undefined) {
      process.env.GATEWAY_DOMAINS = origGatewayDomains;
    } else {
      delete process.env.GATEWAY_DOMAINS;
    }
  });

  it("sanitizes gateway urls in logs", () => {
    expect(
      sanitizeGatewayUrl("wss://nautica.navierr.dev/36.95.152.58-12137"),
    ).toBe("wss://nautica.navierr.dev/***");
    expect(sanitizeGatewayUrl("invalid-url")).toBe("gateway-enabled");
  });

  it("builds valid binary transport headers", () => {
    const key = "fc60147e-76b8-4bc5-b691-90b2da79e3d2";
    const header = buildTransportHeader(key, "acefile.co", 443);
    expect(header).toBeInstanceOf(Buffer);
    expect(header.readUInt8(0)).toBe(0); // version
    expect(header.subarray(1, 17).toString("hex")).toBe(
      "fc60147e76b84bc5b69190b2da79e3d2",
    );
    expect(header.readUInt8(17)).toBe(0); // addon length
    expect(header.readUInt8(18)).toBe(1); // command TCP
    expect(header.readUInt16BE(19)).toBe(443); // port
    expect(header.readUInt8(21)).toBe(2); // domain address type
    const hostLen = header.readUInt8(22);
    expect(header.subarray(23, 23 + hostLen).toString("utf-8")).toBe(
      "acefile.co",
    );
  });

  it("loads GATEWAY_* environment variables properly", () => {
    process.env.GATEWAY_ENABLED = "true";
    process.env.GATEWAY_URL = "wss://nautica.navierr.dev/path";
    process.env.GATEWAY_KEY = "fc60147e-76b8-4bc5-b691-90b2da79e3d2";
    process.env.GATEWAY_DOMAINS = "acefile.co, example.com";

    const config = loadConfigFromEnv();
    expect(config.gatewayEnabled).toBe(true);
    expect(config.gatewayUrl).toBe("wss://nautica.navierr.dev/path");
    expect(config.gatewayKey).toBe("fc60147e-76b8-4bc5-b691-90b2da79e3d2");
    expect(config.gatewayDomains).toEqual(["acefile.co", "example.com"]);
  });

  it("defaults gatewayDomains to acefile.co when omitted", () => {
    delete process.env.GATEWAY_DOMAINS;
    const config = loadConfigFromEnv();
    expect(config.gatewayDomains).toEqual(["acefile.co"]);
  });

  it("does not configure gateway agent when GATEWAY_ENABLED is false", async () => {
    await createServer({
      secret: "test-secret-at-least-32-chars-long",
      gatewayEnabled: false,
      gatewayUrl: "wss://nautica.navierr.dev/path",
      gatewayKey: "fc60147e-76b8-4bc5-b691-90b2da79e3d2",
    });
    expect(getGlobalDispatcher()).toBe(origDispatcher);
  });

  it("configures gateway agent when GATEWAY_ENABLED is true", async () => {
    await createServer({
      secret: "test-secret-at-least-32-chars-long",
      gatewayEnabled: true,
      gatewayUrl: "wss://nautica.navierr.dev/path",
      gatewayKey: "fc60147e-76b8-4bc5-b691-90b2da79e3d2",
    });
    expect(getGlobalDispatcher()).not.toBe(origDispatcher);
  });

  it("creates agent with selective domain routing", () => {
    const agent = createGatewayAgent({
      gatewayUrl: "wss://nautica.navierr.dev/path",
      gatewayKey: "fc60147e-76b8-4bc5-b691-90b2da79e3d2",
      domains: ["acefile.co"],
    });
    expect(agent).toBeDefined();
  });
});
