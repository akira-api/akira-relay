import { logger } from "../src/shared/logger.js";
import { createServer } from "../src/server.js";
import { signStreamUrl } from "../src/core/token.js";

const DEFAULT_SECRET =
  process.env.RELAY_SECRET || "development-secret-key-32-chars-long";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const TARGET_URL = process.argv[2] || "https://acefile.co/f/87122050";

async function main() {
  const { app } = await createServer({
    secret: DEFAULT_SECRET,
    port: PORT,
  });

  const address = await app.listen({ port: PORT, host: "0.0.0.0" });

  const { path } = signStreamUrl(TARGET_URL, DEFAULT_SECRET, 7200);
  const streamUrl = `http://localhost:${PORT}${path}`;

  logger.info(`Server listening at ${address}`);
  logger.info(`Target: ${TARGET_URL}`);
  logger.info(`Stream URL: ${streamUrl}`);

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
