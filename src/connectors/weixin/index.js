// Personal WeChat (iLink) connector — ported from dsh-im's `src/channels/weixin/`.
//
// What is ported faithfully from dsh-im (the part that makes personal WeChat work):
//   - the iLink transport in ./api.mjs (QR login, long-poll getupdates, sendText/Image/File,
//     AES-128-ECB media, 1800-char segmentation) — verbatim DeepSeek protocol.
//   - the long-poll monitor loop (cursor, dedup, message ordering, stale-token detection).
//   - the QR provisioning flow (beginLogin / pollLogin) that binds one WeChat account per bot
//     (multi-bot = multiple accounts), exactly like dsh-im.
//
// What is swapped: dsh-im's brain is DeepSeek's private Harness. Here the brain is DeerFlow —
// every inbound message is handed to core/conversation.js (session<->thread binding, slash
// commands, and streaming via the DeerFlow Gateway). We do NOT reuse DeerFlow's built-in
// wechat channel (per project decision: it is "hard to use").
import { createHash, randomUUID } from "node:crypto";

import {
  createWeixinApi,
  WEIXIN_QR_BASE_URL,
  normalizeWeixinApiBaseUrl,
  WeixinApiError,
  extractWeixinText,
  splitWeixinText,
  weixinMessageId,
} from "./api.mjs";
import * as store from "../../store.js";
import { handleInbound } from "../../core/conversation.js";
import { logger } from "../../logger.js";

const MAX_MESSAGE_CHARS = 1800; // dsh-im DEFAULT_WEIXIN_MAX_MESSAGE_CHARS
const QR_TTL_MS = 5 * 60_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 30_000;
const MAX_SEEN_IDS = 1000;

// ----- iLink identity helpers (ported from dsh-im config-store.mjs) -----
function deriveWeixinBotIdentity(accountId) {
  const raw = typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
  if (!raw) throw new TypeError("accountId is required");
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return {
    botId: `wx_${digest}`,
    tokenRef: `DSH_WEIXIN_BOT_TOKEN_${digest.toUpperCase()}`,
  };
}

function maskWeixinAccountId(accountId) {
  const value = typeof accountId === "string" && accountId.trim() ? accountId.trim() : "";
  if (value.length <= 10) return value ? `${value.slice(0, 3)}•••` : "微信机器人";
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Ported from dsh-im weixin-runtime.mjs: order messages by seq / create_time_ms.
function orderWeixinMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return Array.isArray(messages) ? messages : [];
  }
  const orderField = ["seq", "create_time_ms"].find((field) => messages.every((message) => (
    (typeof message?.[field] === "number" && Number.isFinite(message[field]))
    || (typeof message?.[field] === "string" && message[field].trim() && Number.isFinite(Number(message[field])))
  )));
  if (!orderField) return messages;
  return messages
    .map((message, index) => ({ message, index, order: Number(message[orderField]) }))
    .sort((left, right) => left.order - right.order || left.index - left.index)
    .map(({ message }) => message);
}

const api = createWeixinApi();

// botId -> { abort, monitor }
const runtimes = new Map();
// attemptId -> provisioning attempt record
const attempts = new Map();

// ---------- Runtime: long-poll monitor (ported from WeixinRuntime.#runMonitor) ----------
async function monitorLoop(bot, creds, abortController) {
  const signal = abortController.signal;
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    try {
      const meta = store.getBotMeta(bot.id) || { getUpdatesBuf: "", seenMessageIds: [] };
      const response = await api.getUpdates({
        baseUrl: creds.baseUrl,
        token: creds.token,
        getUpdatesBuf: meta.getUpdatesBuf,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal,
      });
      if (signal.aborted) return;
      const rejected = (response?.ret !== undefined && response.ret !== 0)
        || (response?.errcode !== undefined && response.errcode !== 0);
      if (rejected) {
        const code = response.errcode ?? response.ret;
        throw new WeixinApiError(
          code === -14 ? "stale-token" : "updates-rejected",
          code === -14 ? "登录凭据已失效，请重新扫码绑定。" : "微信消息同步请求被拒绝。",
        );
      }
      consecutiveFailures = 0;
      for (const message of orderWeixinMessages(response?.msgs)) {
        void handleMessage(message, bot, creds).catch((error) => {
          if (signal.aborted) return;
          logger.error("weixin", `bot ${bot.id} 消息处理失败`, error.message);
        });
      }
      if (typeof response?.get_updates_buf === "string" && response.get_updates_buf) {
        store.setBotMeta(bot.id, { ...meta, getUpdatesBuf: response.get_updates_buf });
      }
    } catch (error) {
      if (signal.aborted) return;
      consecutiveFailures += 1;
      if (error instanceof WeixinApiError && error.code === "stale-token") {
        logger.error("weixin", `bot ${bot.id} 登录失效，需重新扫码`);
        store.updateBotStatus(bot.id, { running: false, lastError: "登录凭据已失效，请重新扫码绑定。" });
        return;
      }
      logger.warn("weixin", `bot ${bot.id} 轮询失败 (${consecutiveFailures}/3)`, error.message);
      if (consecutiveFailures >= 3) {
        logger.error("weixin", `bot ${bot.id} 轮询连续失败，停止`, error.message);
        store.updateBotStatus(bot.id, { running: false, lastError: error.message });
        return;
      }
      await delay(Math.min(2000 * 2 ** (consecutiveFailures - 1), 10_000), signal);
    }
  }
}

// ---------- WeChat "typing…" indicator (iLink sendtyping) ----------
// Show a typing state while the agent is thinking, and clear it as soon as the
// first token is produced (or on error). Tickets are per (bot, user) and short-lived.
const typingTickets = new Map();

async function showTyping(bot, creds, sender) {
  try {
    const { typingTicket } = await api.getConfig({
      baseUrl: creds.baseUrl,
      token: creds.token,
      toUserId: sender,
    });
    if (!typingTicket) return;
    typingTickets.set(`${bot.id}:${sender}`, typingTicket);
    await api.sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.token,
      toUserId: sender,
      typingTicket,
      status: 1,
    });
  } catch (e) {
    logger.warn("weixin", `showTyping failed (${sender})`, e?.message);
  }
}

async function hideTyping(bot, creds, sender) {
  const key = `${bot.id}:${sender}`;
  const cached = typingTickets.get(key);
  typingTickets.delete(key);
  let ticket = cached;
  if (!ticket) {
    try {
      ticket = (await api.getConfig({
        baseUrl: creds.baseUrl,
        token: creds.token,
        toUserId: sender,
      })).typingTicket;
    } catch {
      ticket = null;
    }
  }
  if (!ticket) return;
  try {
    await api.sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.token,
      toUserId: sender,
      typingTicket: ticket,
      status: 2,
    });
  } catch (e) {
    logger.warn("weixin", `hideTyping failed (${sender})`, e?.message);
  }
}

async function handleMessage(message, bot, creds) {
  if (message?.message_type === 2) return; // outbound echo from the bot itself
  const messageId = weixinMessageId(message);
  const sender = nonEmptyString(message?.from_user_id);
  if (!messageId || !sender) return;

  // Dedup (ported from dsh-im state-store).
  const meta = store.getBotMeta(bot.id) || { getUpdatesBuf: "", seenMessageIds: [] };
  if (meta.seenMessageIds.includes(messageId)) return;
  meta.seenMessageIds.push(messageId);
  if (meta.seenMessageIds.length > MAX_SEEN_IDS) {
    meta.seenMessageIds.splice(0, meta.seenMessageIds.length - MAX_SEEN_IDS);
  }
  store.setBotMeta(bot.id, meta);

  const text = extractWeixinText(message) || "";
  if (!text.trim()) {
    // v1: text only. Images/files need internal media decryption + DeerFlow attachment support.
    logger.info("weixin", `bot ${bot.id} 收到非文字消息（v1 仅支持文字），忽略`);
    return;
  }

  // Signal "typing…" to the user while the agent prepares a reply.
  void showTyping(bot, creds, sender).catch(() => {});

  const isCommand = text.startsWith("/");
  let acc = "";
  const sendChunks = async (content) => {
    const chunks = splitWeixinText(content, MAX_MESSAGE_CHARS);
    for (const chunk of chunks) {
      await api.sendText({
        baseUrl: creds.baseUrl,
        token: creds.token,
        toUserId: sender,
        text: chunk,
      });
    }
  };
  const reply = async (delta, isFinal) => {
    if (!isFinal) {
      if (delta) void hideTyping(bot, creds, sender).catch(() => {});
      acc += delta;
    }
    if (isFinal) {
      void hideTyping(bot, creds, sender).catch(() => {});
      const shown = acc || delta;
      await sendChunks(shown).catch((e) => logger.error("weixin", "reply failed", e.message));
    }
  };
  const replyError = async (msg) => {
    void hideTyping(bot, creds, sender).catch(() => {});
    await sendChunks(msg).catch((e) => logger.error("weixin", "replyError failed", e.message));
  };

  await handleInbound({
    platform: "weixin",
    botId: bot.id,
    botName: bot.name,
    chatId: sender,
    topicId: null,
    userId: sender,
    text,
    isCommand,
    botSettings: bot.settings,
    reply,
    replyError,
  });
}

// ---------- Connector lifecycle (called by connectors/index.js) ----------
export const weixin = {
  platform: "weixin",

  async startBot(bot) {
    if (runtimes.has(bot.id)) return;
    const creds = store.decryptCredentials(bot);
    if (!creds?.token || !creds?.baseUrl) {
      throw new Error("微信机器人尚未扫码登录，请先通过管理后台绑定微信账号。");
    }
    const abort = new AbortController();
    try {
      await api.notifyStart({ baseUrl: creds.baseUrl, token: creds.token, signal: abort.signal });
    } catch (e) {
      logger.warn("weixin", `bot ${bot.id} notifyStart 失败`, e.message);
    }
    runtimes.set(bot.id, { abort, monitor: null });
    store.updateBotStatus(bot.id, { running: true, lastConnectedAt: Date.now(), lastError: null });
    const monitor = monitorLoop(bot, creds, abort).catch((error) => {
      if (abort.signal.aborted) return;
      logger.error("weixin", `bot ${bot.id} monitor 停止`, error?.message ?? String(error));
    });
    runtimes.get(bot.id).monitor = monitor;
    logger.info("weixin", `bot ${bot.id} (${bot.name}) 已启动长轮询`);
  },

  async stopBot(botId) {
    const rt = runtimes.get(botId);
    if (!rt) return;
    rt.abort.abort();
    runtimes.delete(botId);
    const bot = store.getBot(botId);
    const creds = bot ? store.decryptCredentials(bot) : null;
    if (creds?.token && creds?.baseUrl) {
      try {
        await api.notifyStop({
          baseUrl: creds.baseUrl,
          token: creds.token,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        logger.warn("weixin", `bot ${botId} notifyStop 失败`, e.message);
      }
    }
    store.updateBotStatus(botId, { running: false });
    logger.info("weixin", `bot ${botId} 已停止`);
  },
};

// ---------- QR provisioning (ported from dsh-im WeixinController) ----------
function publicAttempt(record) {
  if (!record) return null;
  return {
    attemptId: record.id,
    status: record.state,
    ...(record.qrcode ? { qrcode: record.qrcode } : {}),
    ...(record.qrcodeUrl ? { qrcodeUrl: record.qrcodeUrl } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    pollIntervalMs: 1000,
    ...(record.botId ? { botId: record.botId } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function listLoggedInTokens() {
  return store.listBots()
    .filter((b) => b.platform === "weixin")
    .map((b) => {
      const c = store.getBot(b.id);
      return c ? store.decryptCredentials(c).token : null;
    })
    .filter(Boolean)
    .slice(-10);
}

// opts: { deerflowUserId, deerflowPat } — when the bind is started by a logged-in
// DeerFlow user, these are carried on the attempt and persisted onto the bot when
// the scan completes (see activateAccount), so the bot's threads belong to that user.
export async function beginLogin(opts = {}) {
  if ([...attempts.values()].some((a) => !["connected", "expired", "failed", "cancelled"].includes(a.state))) {
    throw new Error("已有进行中的微信绑定流程，请先完成或取消。");
  }
  const record = {
    id: randomUUID(),
    state: "starting",
    createdAt: Date.now(),
    expiresAt: Date.now() + QR_TTL_MS,
    controller: new AbortController(),
    qrcode: null,
    qrcodeUrl: null,
    currentBaseUrl: WEIXIN_QR_BASE_URL,
    error: null,
    botId: null,
    task: null,
    deerflowUserId: opts.deerflowUserId || null,
    deerflowPat: opts.deerflowPat || null,
  };
  attempts.set(record.id, record);
  try {
    const login = await api.beginLogin({
      localTokens: listLoggedInTokens(),
      signal: record.controller.signal,
    });
    record.qrcode = login.qrcode;
    record.qrcodeUrl = login.qrcodeUrl;
    record.state = "pending";
    record.expiresAt = Date.now() + QR_TTL_MS;
    record.task = runProvisioning(record).catch((e) => {
      if (e?.name === "AbortError") return;
      logger.error("weixin", "provisioning 失败", e?.message ?? String(e));
    });
    return publicAttempt(record);
  } catch (error) {
    if (record.controller.signal.aborted) {
      record.state = "cancelled";
      record.error = { code: "cancelled", message: "扫码绑定已取消。" };
    } else {
      record.state = "failed";
      record.error = {
        code: error instanceof WeixinApiError ? error.code : "qr-start-failed",
        message: error instanceof WeixinApiError ? error.message : "无法生成微信二维码，请稍后重试。",
      };
    }
    return publicAttempt(record);
  }
}

export function getLoginStatus(attemptId) {
  return publicAttempt(attempts.get(attemptId));
}

export async function cancelLogin(attemptId) {
  const record = attempts.get(attemptId);
  if (!record) return null;
  if (!["connected", "expired", "failed", "cancelled"].includes(record.state)) {
    record.controller.abort();
    await record.task?.catch(() => undefined);
    if (!["connected", "expired", "failed", "cancelled"].includes(record.state)) {
      record.state = "cancelled";
    }
    record.error ??= { code: "cancelled", message: "扫码绑定已取消。" };
  }
  return publicAttempt(record);
}

// Exposed for the dsh-im RPC adapter (admin/dshImRpc.js).
export function getActiveLoginAttempt() {
  for (const record of attempts.values()) {
    if (!["connected", "expired", "failed", "cancelled"].includes(record.state)) {
      return publicAttempt(record);
    }
  }
  return null;
}

export function submitVerifyCode(attemptId, code) {
  const record = attempts.get(attemptId);
  if (record) record.pendingVerifyCode = String(code ?? "").trim();
  return publicAttempt(record);
}

function apiBaseFromServer(value, fallback) {
  const raw = nonEmptyString(value);
  if (!raw) return normalizeWeixinApiBaseUrl(fallback);
  return normalizeWeixinApiBaseUrl(raw.includes("://") ? raw : `https://${raw}`);
}

async function activateAccount(record, { token, accountId, ownerUserId, baseUrl }) {
  const identity = deriveWeixinBotIdentity(accountId);
  const existing = store.getBot(identity.botId);
  const credentials = { baseUrl, token, ownerUserId, accountId };
  if (existing) {
    store.setBotCredentials(identity.botId, credentials);
    existing.enabled = true;
    store.upsertBot(existing);
  } else {
    const created = store.makeBot({
      platform: "weixin",
      name: maskWeixinAccountId(accountId),
      credentials,
      settings: {},
    });
    // makeBot() already persisted the bot under a random id; drop it and re-add under the
    // deterministic dsh-im botId so re-binding the same WeChat account reuses the same bot.
    store.deleteBot(created.id);
    created.id = identity.botId;
    created.enabled = true;
    store.upsertBot(created);
  }
  record.botId = identity.botId;
  // Tie the bot to the DeerFlow user who started the bind (if any). Re-binding the
  // same WeChat account by a different user re-points the bot at that user.
  if (record.deerflowUserId || record.deerflowPat) {
    store.setBotDeerflowUser(identity.botId, {
      deerflowUserId: record.deerflowUserId,
      deerflowPat: record.deerflowPat,
    });
  }
  const bot = store.getBot(identity.botId);
  await weixin.startBot(bot);
  return identity.botId;
}

async function runProvisioning(record) {
  try {
    while (!record.controller.signal.aborted && Date.now() < record.expiresAt) {
      const response = await api.pollLogin({
        qrcode: record.qrcode,
        baseUrl: record.currentBaseUrl,
        verifyCode: record.pendingVerifyCode,
        signal: record.controller.signal,
      });
      if (record.controller.signal.aborted) return;
      const status = response?.status;
      if (status === "wait") {
        record.state = "pending";
      } else if (status === "scaned") {
        record.state = "scanned";
      } else if (status === "need_verifycode") {
        record.state = "needs_verification";
      } else if (status === "verify_code_blocked") {
        record.state = "failed";
        record.error = { code: "verification-blocked", message: "配对码多次错误，请重新生成二维码。" };
        break;
      } else if (status === "expired") {
        record.state = "expired";
        record.error = { code: "expired", message: "二维码已过期，请重新生成。" };
        break;
      } else if (status === "scaned_but_redirect") {
        record.currentBaseUrl = apiBaseFromServer(response.redirect_host, record.currentBaseUrl);
        record.state = "scanned";
      } else if (status === "binded_redirect") {
        const existing = store.listBots().find((b) => b.platform === "weixin" && store.getBot(b.id)?.status?.running);
        if (!existing) {
          record.state = "failed";
          record.error = { code: "already-bound", message: "该微信账号已绑定，但本机没有可恢复的凭据。" };
        } else {
          record.state = "connected";
          record.botId = existing.id;
          record.alreadyConnected = true;
        }
        break;
      } else if (status === "confirmed") {
        const token = nonEmptyString(response.bot_token);
        const accountId = nonEmptyString(response.ilink_bot_id);
        const ownerUserId = nonEmptyString(response.ilink_user_id);
        if (!token || !accountId || !ownerUserId) {
          throw new WeixinApiError("incomplete-login", "微信授权成功，但返回的账号凭据不完整。");
        }
        record.state = "connecting";
        const baseUrl = apiBaseFromServer(response.baseurl, record.currentBaseUrl);
        await activateAccount(record, { token, accountId, ownerUserId, baseUrl });
        record.state = "connected";
        record.error = null;
        break;
      }
    }
    if (!record.controller.signal.aborted
      && Date.now() >= record.expiresAt
      && !["connected", "expired", "failed", "cancelled"].includes(record.state)) {
      record.state = "expired";
      record.error = { code: "expired", message: "二维码已过期，请重新生成。" };
    }
  } finally {
    record.pendingVerifyCode = null;
    // Keep a connected attempt in the map so the dsh-im RPC poll (provision.poll)
    // can still report status:connected with its botId; getActiveLoginAttempt()
    // already excludes terminal states, so it never shows up as in-progress.
  }
}
