import { logger } from "../src/shared/logger.js";
import { createServer } from "../src/server.js";
import { signStreamUrl } from "../src/core/token.js";

const DEFAULT_SECRET =
  process.env.RELAY_SECRET || "development-secret-key-32-chars-long";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const TARGET_URL = process.argv[2] || "https://acefile.co/f/87122050";
const INTERNAL_KEY = process.env.INTERNAL_RELAY_KEY;

async function main() {
  const { app } = await createServer({
    secret: DEFAULT_SECRET,
    port: PORT,
    internalRelayKey: INTERNAL_KEY,
  });

  const address = await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info(`Server listening at ${address}`);

  // Test batch resolve endpoint
  logger.info("Testing batch resolve via POST /internal/resolve...");
  try {
    const server = TARGET_URL.includes("blogger.com") ? "blogger" : "acefile";
    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: INTERNAL_KEY ? { "x-relay-key": INTERNAL_KEY } : {},
      payload: {
        sources: [
          {
            server,
            resolution: "1080p",
            url: TARGET_URL,
          },
          {
            server,
            resolution: "720p",
            url: TARGET_URL,
          },
        ],
      },
    });

    const body = JSON.parse(res.body);
    logger.info(`Batch resolve status: ${res.statusCode}`);
    if (body.streams && body.streams.length > 0) {
      for (const s of body.streams) {
        logger.info(`[${s.resolution}] (${s.server}) -> http://localhost:${PORT}${s.url}`);
      }
    } else {
      logger.warn(`No playable streams returned: ${res.body}`);
    }
  } catch (err: any) {
    logger.error("Resolve test error:", err?.message || err);
  }

  // Also print direct fallback stream URL
  const { path } = signStreamUrl(TARGET_URL, DEFAULT_SECRET, 7200);
  const streamUrl = `http://localhost:${PORT}${path}`;
  logger.info(`Direct fallback stream URL: ${streamUrl}`);

  const shutdown = async () => {
    logger.info("Stopping server");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: any) => {
  logger.error("Failed to start test server:", err?.message || err);
  process.exit(1);
});
