// Connector registry + lifecycle manager.
import { feishu } from "./feishu/index.js";
import { weixin } from "./weixin/index.js";
import * as store from "../store.js";
import { logger } from "../logger.js";

export const connectors = { feishu, weixin };

// Descriptors drive the admin UI forms and document required credentials per platform.
export const platformDescriptors = {
  feishu: {
    label: "飞书",
    credentialFields: [
      { key: "app_id", label: "App ID", secret: false },
      { key: "app_secret", label: "App Secret", secret: true },
    ],
    settingFields: [
      { key: "model_name", label: "默认模型", placeholder: "留空用 DeerFlow 默认" },
      { key: "agent_name", label: "默认智能体", placeholder: "lead_agent" },
    ],
  },
  weixin: {
    label: "个人微信 (iLink)",
    // 个人微信用扫码登录，无需静态 App 密钥。凭证在扫码成功后写入。
    credentialFields: [],
    loginMethod: "qr",
    settingFields: [
      { key: "model_name", label: "默认模型", placeholder: "留空用 DeerFlow 默认" },
      { key: "agent_name", label: "默认智能体", placeholder: "lead_agent" },
    ],
  },
};

export async function startBot(bot) {
  const c = connectors[bot.platform];
  if (!c) throw new Error(`unknown platform ${bot.platform}`);
  await c.startBot(bot);
}

export async function stopBot(botId) {
  for (const c of Object.values(connectors)) {
    try {
      await c.stopBot(botId);
    } catch (e) {
      logger.warn("mgr", `stop ${botId} via ${c.platform} failed`, e.message);
    }
  }
}

// Start every bot flagged enabled at boot (used by index.js).
export async function startEnabledBots() {
  for (const pub of store.listBots()) {
    if (!pub.enabled) continue;
    const bot = store.getBot(pub.id);
    if (!bot) continue;
    try {
      await startBot(bot);
    } catch (e) {
      logger.error("mgr", `failed to start bot ${bot.id} (${bot.name})`, e.message);
      store.updateBotStatus(bot.id, { running: false, lastError: e.message });
    }
  }
}
