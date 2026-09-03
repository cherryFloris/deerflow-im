// dsh-im Host RPC contract adapter for im-bridge.
//
// The vendored dsh-im React UI (admin-ui/src/dsh-im) calls a single transport:
//   rpcCall(channel, endpoint, payload, signal) -> { ok: true, value } | { ok: false, error }
// This module implements that envelope for the `weixin` and `feishu` channels, mapping
// dsh-im's RPC vocabulary onto im-bridge's store + connectors. The shapes returned here
// are the exact JSON the vendored normalizers (normalizeSnapshot / normalizeBotsSnapshot /
// normalizeProvisioning / normalizeBotConnection) expect.
import * as store from "../store.js";
import * as mgr from "../connectors/index.js";
import QRCode from "qrcode";
import {
  beginLogin,
  cancelLogin,
  getActiveLoginAttempt,
  getLoginStatus,
  submitVerifyCode,
} from "../connectors/weixin/index.js";
import { logger } from "../logger.js";

const revisions = { weixin: 0, feishu: 0 };
function nextRevision(channel) {
  revisions[channel] = (revisions[channel] || 0) + 1;
  return revisions[channel];
}

// Render the WeChat (iLink) QR landing URL into a PNG data URL. The vendored weixin
// UI's safeQrSource() only accepts data:image/(png|webp|svg+xml);base64, and Tencent's
// qrcodeUrl returns an HTML landing page (not a raw image) when fetched, so we render
// the QR ourselves — exactly how dsh-im's Host produces qrCodeDataUrl.
async function renderWeixinQr(qrcodeUrl) {
  if (!qrcodeUrl || typeof qrcodeUrl !== "string") return undefined;
  try {
    return await QRCode.toDataURL(qrcodeUrl, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  } catch (e) {
    logger.warn("dshImRpc", "failed to render weixin QR", e?.message);
    return undefined;
  }
}

// ---------- envelope helpers ----------
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// ---------- weixin ----------
async function weixinProvisioningToRpc(attempt) {
  if (!attempt) return null;
  const qrCodeDataUrl = await renderWeixinQr(attempt.qrcodeUrl);
  const out = {
    attemptId: attempt.attemptId,
    status: attempt.status,
    expiresAt: attempt.expiresAt ?? Date.now(),
    pollIntervalMs: attempt.pollIntervalMs || 1000,
  };
  if (qrCodeDataUrl) out.qrCodeDataUrl = qrCodeDataUrl;
  if (attempt.qrcodeUrl) out.verificationUrl = attempt.qrcodeUrl;
  if (attempt.botId) out.botId = attempt.botId;
  if (attempt.alreadyConnected) out.alreadyConnected = true;
  if (attempt.error) out.error = attempt.error;
  return out;
}

function weixinBotToRpc(bot) {
  const full = store.getBot(bot.id);
  const connected = Boolean(full?.status?.running);
  const lastError = full?.status?.lastError;
  return {
    botId: bot.id,
    state: connected ? "connected" : "offline",
    connected,
    configured: true,
    workspace: full?.workspace || "",
    agentPreset: full?.agentPreset || "",
    contextEnhancement: full?.contextEnhancement || null,
    bot: {
      name: bot.name,
      accountIdMasked: bot.name,
    },
    health: {
      status: connected ? "healthy" : "offline",
      summary: connected ? "微信连接正常" : "微信连接未就绪",
      lastCheckedAt: full?.status?.lastConnectedAt || null,
    },
    stats: { messagesReceived: 0, messagesReplied: 0 },
    lastMessageError: null,
    error: lastError ? { code: "WEIXIN_ACCOUNT_ERROR", message: lastError } : null,
  };
}

async function weixinStatus() {
  const bots = store.listBots().filter((b) => b.platform === "weixin");
  const snapshotBots = bots.map(weixinBotToRpc);
  const active = getActiveLoginAttempt();
  const provisioning = active ? await weixinProvisioningToRpc(active) : null;
  return {
    schemaVersion: 1,
    revision: nextRevision("weixin"),
    state: "offline",
    bots: snapshotBots,
    totals: {
      configured: snapshotBots.length,
      connected: snapshotBots.filter((b) => b.connected).length,
    },
    provisioning,
    testMessage: null,
    agentPresetCatalog: [],
  };
}

async function weixinDispatch(endpoint, payload = {}) {
  switch (endpoint) {
    case "connection.status":
      return ok(await weixinStatus());

    case "provision.begin": {
      try {
        const attempt = await beginLogin();
        return ok(await weixinProvisioningToRpc(attempt));
      } catch (e) {
        return fail("WEIXIN_PROVISION_BEGIN_FAILED", e?.message || "无法生成微信二维码，请稍后重试。");
      }
    }

    case "provision.poll": {
      const attempt = getLoginStatus(payload?.attemptId);
      if (!attempt) {
        return fail("WEIXIN_PROVISION_NOT_FOUND", "绑定任务不存在或已结束，请重新生成二维码。");
      }
      return ok(await weixinProvisioningToRpc(attempt));
    }

    case "provision.verify": {
      const attempt = submitVerifyCode(payload?.attemptId, payload?.verifyCode);
      if (!attempt) {
        return fail("WEIXIN_PROVISION_NOT_FOUND", "绑定任务不存在或已结束，请重新生成二维码。");
      }
      return ok(await weixinProvisioningToRpc(attempt));
    }

    case "provision.cancel": {
      const attempt = await cancelLogin(payload?.attemptId);
      return ok(attempt || { status: "cancelled" });
    }

    case "bot.reconnect": {
      const bot = store.getBot(payload?.botId);
      if (!bot || bot.platform !== "weixin") {
        return fail("WEIXIN_BOT_NOT_FOUND", "微信机器人不存在。");
      }
      try {
        await mgr.stopBot(bot.id);
        await mgr.startBot(bot);
        return ok(await weixinStatus());
      } catch (e) {
        return fail("WEIXIN_RECONNECT_FAILED", e?.message || "微信重连失败。");
      }
    }

    case "bot.delete": {
      const bot = store.getBot(payload?.botId);
      if (!bot || bot.platform !== "weixin") {
        return fail("WEIXIN_BOT_NOT_FOUND", "微信机器人不存在。");
      }
      await mgr.stopBot(bot.id);
      store.deleteBot(bot.id);
      return ok(await weixinStatus());
    }

    case "bot.workspace.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("WEIXIN_BOT_NOT_FOUND", "微信机器人不存在。");
      store.setBotWorkspace(bot.id, payload?.workspace);
      return ok(await weixinStatus());
    }

    case "bot.preset.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("WEIXIN_BOT_NOT_FOUND", "微信机器人不存在。");
      store.setBotAgentPreset(bot.id, payload?.agentPreset);
      return ok(await weixinStatus());
    }

    case "bot.context-enhancement.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("WEIXIN_BOT_NOT_FOUND", "微信机器人不存在。");
      store.setBotContextEnhancement(bot.id, payload?.config);
      return ok(await weixinStatus());
    }

    default:
      return fail("WEIXIN_UNKNOWN_ENDPOINT", `不支持的微信 RPC 端点：${endpoint}`);
  }
}

// ---------- feishu ----------
function maskFeishuAppId(appId) {
  if (!appId || typeof appId !== "string") return "应用标识已安全保存";
  if (appId.length <= 8) return `${appId.slice(0, 3)}•••`;
  return `${appId.slice(0, 6)}••••${appId.slice(-4)}`;
}

function feishuBotToRpc(bot) {
  const full = store.getBot(bot.id);
  const connected = Boolean(full?.status?.running);
  const creds = full ? store.decryptCredentials(full) : {};
  const lastError = full?.status?.lastError;
  return {
    botId: bot.id,
    state: connected ? "connected" : "offline",
    connected,
    configured: true,
    workspace: full?.workspace || "",
    agentPreset: full?.agentPreset || "",
    contextEnhancement: full?.contextEnhancement || null,
    groupResponseMode: full?.groupResponseMode === "all" ? "all" : "mention",
    groupMessagePermissionGranted: full?.groupResponseMode === "all",
    bot: {
      name: bot.name,
      appIdMasked: maskFeishuAppId(creds.app_id),
      domain: full?.settings?.domain === "lark" ? "lark" : "feishu",
    },
    health: {
      status: connected ? "healthy" : "offline",
      summary: connected ? "长连接运行正常" : "机器人尚未连接",
      lastCheckedAt: full?.status?.lastConnectedAt || null,
    },
    lastMessageError: null,
    error: lastError ? { code: "FEISHU_BOT_OFFLINE", message: lastError } : null,
  };
}

async function feishuStatus() {
  const bots = store.listBots().filter((b) => b.platform === "feishu");
  const snapshotBots = bots.map(feishuBotToRpc);
  return {
    schemaVersion: 1,
    revision: nextRevision("feishu"),
    state: "offline",
    bots: snapshotBots,
    totals: {
      configured: snapshotBots.length,
      connected: snapshotBots.filter((b) => b.connected).length,
    },
    provisioning: undefined,
    error: undefined,
    agentPresetCatalog: [],
  };
}

async function feishuDispatch(endpoint, payload = {}) {
  // QR-based provisioning (provision.begin / poll / cancel / callback-repair /
  // group-message-permission) requires auto-creating a Feishu app via the open
  // platform — a capability im-bridge does not implement. Feishu is bound here via
  // manual App ID / App Secret (bot.bind-credentials). Report the gap clearly.
  if (endpoint === "provision.begin" || endpoint === "bot.callback-repair.begin" || endpoint === "bot.group-message-permission.begin") {
    return fail(
      "FEISHU_QR_UNSUPPORTED",
      "当前桥接暂不支持飞书扫码授权，请点击「手动接入」使用 App ID / App Secret 绑定。",
    );
  }
  if (endpoint === "provision.poll" || endpoint === "provision.cancel") {
    return fail("FEISHU_QR_UNSUPPORTED", "飞书扫码授权不可用，请使用手动接入。");
  }

  switch (endpoint) {
    case "connection.status":
      return ok(await feishuStatus());

    case "bot.bind-credentials": {
      const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
      const appSecret = typeof payload?.appSecret === "string" ? payload.appSecret.trim() : "";
      if (!appId || !appSecret) {
        return fail("FEISHU_CREDENTIALS_REQUIRED", "App ID 和 App Secret 均为必填。");
      }
      try {
        const created = store.makeBot({
          platform: "feishu",
          name: payload?.name || "飞书机器人",
          credentials: { app_id: appId, app_secret: appSecret },
          settings: { agent_name: "", model_name: "" },
        });
        created.enabled = true;
        store.upsertBot(created);
        await mgr.startBot(created);
        return ok(await feishuStatus());
      } catch (e) {
        return fail("FEISHU_BIND_FAILED", e?.message || "飞书凭据绑定失败。");
      }
    }

    case "bot.reconnect": {
      const bot = store.getBot(payload?.botId);
      if (!bot || bot.platform !== "feishu") {
        return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      }
      try {
        await mgr.stopBot(bot.id);
        await mgr.startBot(bot);
        return ok(await feishuStatus());
      } catch (e) {
        return fail("FEISHU_RECONNECT_FAILED", e?.message || "飞书重连失败。");
      }
    }

    case "bot.delete": {
      const bot = store.getBot(payload?.botId);
      if (!bot || bot.platform !== "feishu") {
        return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      }
      await mgr.stopBot(bot.id);
      store.deleteBot(bot.id);
      return ok(await feishuStatus());
    }

    case "bot.workspace.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      store.setBotWorkspace(bot.id, payload?.workspace);
      return ok(await feishuStatus());
    }

    case "bot.preset.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      store.setBotAgentPreset(bot.id, payload?.agentPreset);
      return ok(await feishuStatus());
    }

    case "bot.context-enhancement.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      store.setBotContextEnhancement(bot.id, payload?.config);
      return ok(await feishuStatus());
    }

    case "bot.group-response-mode.set": {
      const bot = store.getBot(payload?.botId);
      if (!bot) return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      store.setBotGroupResponseMode(bot.id, payload?.groupResponseMode);
      return ok(await feishuStatus());
    }

    case "bot.disconnect": {
      const bot = store.getBot(payload?.botId);
      if (!bot || bot.platform !== "feishu") {
        return fail("FEISHU_BOT_NOT_FOUND", "飞书机器人不存在。");
      }
      await mgr.stopBot(bot.id);
      return ok(await feishuStatus());
    }

    default:
      return fail("FEISHU_UNKNOWN_ENDPOINT", `不支持的飞书 RPC 端点：${endpoint}`);
  }
}

// ---------- dispatcher ----------
export async function dispatchRpc(channel, endpoint, payload = {}, signal) {
  try {
    if (channel === "/weixin" || channel === "weixin") {
      return await weixinDispatch(endpoint, payload);
    }
    if (channel === "/feishu" || channel === "feishu") {
      return await feishuDispatch(endpoint, payload);
    }
    return fail("UNKNOWN_CHANNEL", `不支持的渠道：${channel}`);
  } catch (e) {
    logger.error("dshImRpc", `dispatch ${channel}/${endpoint} failed`, e?.message);
    return fail("RPC_INTERNAL_ERROR", e?.message || "内部错误");
  }
}
