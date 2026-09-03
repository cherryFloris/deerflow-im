// Feishu (Lark) connector — ported from dsh-im's src/channels/feishu/.
//
// What is ported faithfully from dsh-im:
//   - the Lark long-connection setup in ./index.js (Client / WSClient / EventDispatcher,
//     onReady/onError/onReconnecting) — same official @larksuiteoapi/node-sdk dsh-im uses.
//   - the message parser ./message-utils.mjs (conversationKey session keying, extractInboundMessage).
//   - the streaming card engine ./cards.mjs (VerifiedFeishuChannel: real CardKit streaming cards
//     via cardElement.content, the "thinking -> update -> finalize" experience dsh-im ships).
//
// What is swapped: dsh-im's brain (DeepSeek Harness) is replaced by DeerFlow — every inbound
// message is handed to core/conversation.js (session<->thread, slash commands, Gateway streaming).
// We do NOT reuse DeerFlow's built-in feishu channel (per project decision).
import * as lark from "@larksuiteoapi/node-sdk";
import * as store from "../../store.js";
import { handleInbound } from "../../core/conversation.js";
import { logger } from "../../logger.js";
import { VerifiedFeishuChannel } from "./cards.mjs";
import { conversationKey, extractInboundMessage, isBotSender } from "./message-utils.mjs";

const active = new Map(); // botId -> { client, wsClient, stop, status }

function safeJson(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return {};
  }
}

function domainOf(settings) {
  const d = typeof settings?.domain === "string" && settings.domain.trim() ? settings.domain.trim() : "feishu";
  return d === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

// Ported from dsh-im feishu-runtime.mjs: accept an im.message.receive_v1 event,
// key the session, parse text, and stream the answer through a CardKit card.
async function handleEvent(event, bot, client) {
  const message = event?.message || event?.event?.message;
  if (!message) return;
  if (isBotSender(event)) return; // ignore the bot's own echoes

  const inbound = extractInboundMessage(event, client);
  const text = (inbound?.content || "").trim();
  if (!text) {
    logger.info("feishu", `bot ${bot.id} 收到非文字消息（v1 仅支持文字），忽略`);
    return;
  }

  const chatType = message.chat_type;
  const chatId = message.chat_id;
  const senderId = event?.sender?.sender_id?.open_id || message?.sender?.sender_id?.open_id || null;
  const topicId = chatType === "p2p"
    ? null
    : (message.thread_id || message.root_id || message.parent_id || null);
  const isCommand = text.startsWith("/");
  const replyTo = message.message_id;

  const channel = new VerifiedFeishuChannel({
    client,
    initialText: "DeerFlow 正在思考…",
  });

  try {
    await channel.stream(chatId, {
      markdown: async (controller) => {
        let acc = "";
        const reply = async (delta) => {
          if (delta) {
            acc += delta;
            await controller.setContent(acc);
          }
        };
        const replyError = async (msg) => {
          await controller.setContent(msg);
        };
        await handleInbound({
          platform: "feishu",
          botId: bot.id,
          botName: bot.name,
          chatId,
          topicId,
          userId: senderId,
          text,
          isCommand,
          botSettings: bot.settings,
          reply,
          replyError,
        });
      },
    }, { replyTo });
  } catch (error) {
    logger.error("feishu", `bot ${bot.id} 处理消息失败`, error?.message ?? String(error));
  }
}

export const feishu = {
  platform: "feishu",

  async startBot(bot) {
    if (active.has(bot.id)) return;
    const creds = store.decryptCredentials(bot);
    const appId = creds.app_id;
    const appSecret = creds.app_secret;
    if (!appId || !appSecret) throw new Error("feishu bot missing app_id/app_secret");

    const client = new lark.Client({
      appId,
      appSecret,
      domain: domainOf(bot.settings),
    });

    // NOTE: `EventDispatcher.register(handles)` takes a SINGLE object of
    // { eventType: handler }. Passing (key, handler) two-arg form silently
    // mis-registers (Object.keys(string) => char indices "0".."n"), so the
    // real handler never fires and Feishu messages are dropped with
    // "no im.message.receive_v1 handle". Register as an object.
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (event) => {
        void handleEvent(event, bot, client).catch((e) => {
          logger.error("feishu", "handleEvent failed", e?.message ?? String(e));
        });
      },
      "im.message.reaction.created_v1": () => undefined,
      "im.message.reaction.deleted_v1": () => undefined,
      "card.action.trigger": () => undefined,
    });

    const entry = { client, wsClient: null, status: { running: false }, stop: null };
    active.set(bot.id, entry);

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain: domainOf(bot.settings),
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => {
        entry.status.ready = true;
        entry.status.running = true;
        entry.status.feishuLongConnectionState = "connected";
        store.updateBotStatus(bot.id, { running: true, lastConnectedAt: Date.now(), lastError: null });
        logger.info("feishu", `bot ${bot.name} (${bot.id}) WebSocket 已连接`);
      },
      onError: (error) => {
        entry.status.ready = false;
        entry.status.running = false;
        entry.status.feishuLongConnectionState = "failed";
        entry.status.lastError = error?.message ?? String(error);
        store.updateBotStatus(bot.id, { running: false, lastError: error?.message ?? String(error) });
        logger.error("feishu", `bot ${bot.id} WebSocket 错误`, error?.message ?? String(error));
      },
      onReconnecting: () => {
        entry.status.ready = false;
        entry.status.feishuLongConnectionState = "reconnecting";
        store.updateBotStatus(bot.id, { running: false });
      },
      onReconnected: () => {
        entry.status.ready = true;
        entry.status.running = true;
        entry.status.feishuLongConnectionState = "connected";
        store.updateBotStatus(bot.id, { running: true, lastConnectedAt: Date.now(), lastError: null });
      },
    });
    entry.wsClient = wsClient;
    entry.stop = () => {
      try {
        wsClient.close({ force: true });
      } catch (e) {
        logger.warn("feishu", "stop error", e?.message);
      }
    };
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
    } catch (e) {
      logger.error("feishu", `bot ${bot.id} WS 启动失败`, e?.message);
      active.delete(bot.id);
      store.updateBotStatus(bot.id, { running: false, lastError: e?.message });
      throw e;
    }
    logger.info("feishu", `bot ${bot.name} (${bot.id}) 已启动`);
  },

  async stopBot(botId) {
    const a = active.get(botId);
    if (a) {
      a.stop?.();
      active.delete(botId);
      store.updateBotStatus(botId, { running: false });
      logger.info("feishu", `bot ${botId} 已停止`);
    }
  },
};
