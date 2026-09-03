// Entry point for the DeerFlow IM bridge.
// Bridges IM platforms (Feishu, personal WeChat/iLink) to DeerFlow Gateway via
// PAT-authenticated REST/SSE. DeerFlow source is not modified; this is a standalone service.
// Feishu and WeChat channel implementations are ported from dsh-im; the brain is DeerFlow.
import { config, requirePat } from "./config.js";
import { logger } from "./logger.js";
import { startAdminServer } from "./admin/server.js";
import { startEnabledBots, stopBot } from "./connectors/index.js";
import * as store from "./store.js";

async function main() {
  try {
    requirePat();
  } catch (e) {
    logger.error("main", e.message);
    process.exit(1);
  }

  logger.info("main", `DeerFlow IM bridge starting (gateway=${config.gatewayUrl})`);
  startAdminServer();
  await startEnabledBots();

  const shutdown = async () => {
    logger.info("main", "shutting down, stopping bots...");
    for (const bot of store.listBots()) {
      try {
        await stopBot(bot.id);
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  logger.error("main", "fatal", e);
  process.exit(1);
});
