// Conversation orchestration: maps an inbound IM message to a DeerFlow thread,
// runs the agent, and streams tokens back to the platform via the connector's
// reply callback. Also implements the dsh-im-style slash commands.
import * as store from "../store.js";
import { DeerFlowClient } from "../deerflow/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Threads are owned by whichever PAT authenticates the call. A bot bound by a
// logged-in DeerFlow user carries that user's PAT (store.setBotDeerflowUser), so
// threads it creates belong to that user and appear only for them in the DeerFlow
// web UI. Bots without one fall back to the global config.pat.
function clientForBot(botId) {
  const pat = store.getBotDeerflowPat(botId) || config.pat;
  return new DeerFlowClient({ pat });
}

async function resolveThread(ctx) {
  const { platform, botId, chatId, topicId } = ctx;
  const existing = store.getSession(platform, botId, chatId, topicId);
  if (existing && existing.threadId) return existing.threadId;
  const client = clientForBot(botId);
  const threadId = await client.createThread();
  store.setSession(platform, botId, chatId, topicId, threadId, { userId: ctx.userId });
  logger.info("conv", `created thread ${threadId} for ${platform}/${botId}/${chatId}`);
  return threadId;
}

async function activeModelAgent(ctx) {
  const profile = store.getProfile(ctx.platform, ctx.botId, ctx.chatId) || {};
  return {
    modelName: profile.modelName || ctx.botSettings?.modelName || null,
    agentName: profile.agentName || ctx.botSettings?.agentName || null,
  };
}

export async function handleInbound(ctx) {
  const text = (ctx.text || "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    await handleCommand(ctx, text);
    return;
  }

  try {
    await runThread(ctx, text);
  } catch (e) {
    logger.error("conv", "run failed", e.message);
    try {
      await ctx.replyError(`⚠️ 调用 DeerFlow 出错：${e.message}`);
    } catch {
      /* ignore */
    }
  }
}

// DeerFlow allows at most one active run per thread. Because we reuse one thread
// per chat session, a follow-up message sent while the previous reply is still
// streaming is rejected with HTTP 409 ("Thread ... already has an active run"),
// and im-bridge then recalls the in-progress card — which looks like the bot
// ignoring the user. On that specific error we drop the cached session (so the
// next resolveThread creates a brand-new thread) and retry once, guaranteeing a
// reply instead of a silently deleted card.
function isActiveRunError(e) {
  const m = e?.message || "";
  return m.includes("409") || m.includes("already has an active run");
}

async function runThread(ctx, text) {
  let threadId = await resolveThread(ctx);
  try {
    await streamInto(threadId, ctx, text);
  } catch (e) {
    if (isActiveRunError(e)) {
      logger.warn("conv", "thread busy, retrying on a fresh thread", e.message);
      store.clearSession(ctx.platform, ctx.botId, ctx.chatId, ctx.topicId);
      threadId = await resolveThread(ctx);
      await streamInto(threadId, ctx, text);
      return;
    }
    throw e;
  }
}

async function streamInto(threadId, ctx, text) {
  const { modelName, agentName } = await activeModelAgent(ctx);
  const client = clientForBot(ctx.botId);
  await client.streamRun(
    threadId,
    text,
    { modelName, agentName },
    (delta, isFinal) => {
      ctx.reply(delta, isFinal).catch((e) => logger.error("conv", "reply failed", e.message));
    }
  );
}

async function handleCommand(ctx, raw) {
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const { platform, botId, chatId, topicId, reply, replyError } = ctx;

  switch ((cmd || "").toLowerCase()) {
    case "new":
    case "reset": {
      store.clearSession(platform, botId, chatId, topicId);
      await reply("✅ 已开始新对话。", true);
      return;
    }
    case "model": {
      if (!arg) {
        const cur = (await activeModelAgent(ctx)).modelName;
        await reply(`当前模型：${cur || "(默认)"}。用法：/model <模型名>`, true);
        return;
      }
      store.setProfile(platform, botId, chatId, { modelName: arg });
      await reply(`✅ 已切换模型为：${arg}`, true);
      return;
    }
    case "preset": {
      if (!arg) {
        const cur = (await activeModelAgent(ctx)).agentName;
        await reply(`当前智能体：${cur || "(lead_agent 默认)"}。用法：/preset <agent_name>`, true);
        return;
      }
      store.setProfile(platform, botId, chatId, { agentName: arg });
      await reply(`✅ 已切换智能体为：${arg}`, true);
      return;
    }
    case "status": {
      const thread = store.getSession(platform, botId, chatId, topicId);
      const { modelName, agentName } = await activeModelAgent(ctx);
      const lines = [
        `平台：${platform}`,
        `机器人：${ctx.botName || botId}`,
        `会话线程：${thread ? thread.threadId : "(未创建)"}`,
        `模型：${modelName || "(默认)"}`,
        `智能体：${agentName || "lead_agent"}`,
      ];
      await reply(lines.join("\n"), true);
      return;
    }
    case "compact": {
      try {
        const summary = await summarize(ctx);
        store.clearSession(platform, botId, chatId, topicId);
        await reply(`✅ 已压缩对话，摘要如下：\n\n${summary}`, true);
      } catch (e) {
        await replyError(`⚠️ 压缩失败：${e.message}`, true);
      }
      return;
    }
    case "help":
    default: {
      const help = [
        "可用命令：",
        "/new · 开始新对话",
        "/model <名称> · 切换模型",
        "/preset <名称> · 切换智能体",
        "/status · 查看当前会话状态",
        "/compact · 总结并压缩对话",
        "/help · 显示本帮助",
      ].join("\n");
      await reply(help, true);
      return;
    }
  }
}

// Produce a concise summary of the current conversation, then the caller resets the thread.
async function summarize(ctx) {
  const thread = store.getSession(ctx.platform, ctx.botId, ctx.chatId, ctx.topicId);
  if (!thread) return "(无对话内容)";
  const client = clientForBot(ctx.botId);
  let historyText = "";
  try {
    const hist = await client.getHistory(thread.threadId, 60);
    historyText = historyToText(hist);
  } catch (e) {
    logger.warn("conv", "getHistory failed", e.message);
  }
  if (!historyText.trim()) return "(无对话内容)";

  const prompt =
    "请用简洁的中文总结以下对话的核心要点、已完成的任务与待办，不超过 300 字：\n\n" + historyText;
  let summary = "";
  const tmp = await client.createThread();
  await client.streamRun(tmp, prompt, {}, (delta, isFinal) => {
    if (!isFinal && delta) summary += delta;
  });
  return summary.trim() || "(总结生成失败)";
}

function historyToText(hist) {
  const messages =
    hist?.data?.messages || hist?.messages || hist?.values?.messages || hist?.data?.values?.messages || [];
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      const role = String(m?.type || m?.role || "user").toUpperCase();
      const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content || "");
      return `${role}: ${content}`;
    })
    .join("\n");
}
