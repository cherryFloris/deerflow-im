// JSON-file persistence for bots and chat<->thread session bindings.
// Credentials are encrypted at rest with AES-256-GCM when IM_BRIDGE_SECRET is set
// (local-first security, mirrors dsh-im's credential store). Status APIs never
// return plaintext secrets.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

const ALGO = "aes-256-gcm";

function key() {
  return crypto.createHash("sha256").update(config.secret || "insecure-default").digest();
}

function encrypt(plain) {
  if (plain == null) return null;
  if (!config.secret) {
    // No secret configured: store obfuscated (base64) only, with a warning elsewhere.
    return { __obf: true, v: Buffer.from(String(plain), "utf8").toString("base64") };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { __enc: true, iv: iv.toString("base64"), tag: tag.toString("base64"), v: enc.toString("base64") };
}

function decrypt(rec) {
  if (rec == null) return "";
  if (rec.__obf) return Buffer.from(rec.v, "base64").toString("utf8");
  if (rec.__enc) {
    const iv = Buffer.from(rec.iv, "base64");
    const tag = Buffer.from(rec.tag, "base64");
    const dec = Buffer.from(rec.v, "base64");
    const cipher = crypto.createDecipheriv(ALGO, key(), iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(dec), cipher.final()]).toString("utf8");
  }
  return "";
}

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logger.error("store", "failed to read", file, e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const botsFile = path.join(config.dataDir, "bots.json");
const sessionsFile = path.join(config.dataDir, "sessions.json");
const profilesFile = path.join(config.dataDir, "profiles.json");

/** @type {BotRecord[]} */
let bots = readJson(botsFile, []);
let sessions = readJson(sessionsFile, {});
// Per (platform, bot, chat) model/agent overrides set via /model and /preset.
// Kept separate from the thread session so /new resets the thread but keeps the choice.
let profiles = readJson(profilesFile, {});

if (!config.secret) {
  logger.warn("store", "IM_BRIDGE_SECRET is not set; credentials are stored obfuscated (base64), not encrypted. Set a strong secret in production.");
}

// ---------- Bots ----------

export function listBots() {
  return bots.map(toPublicBot);
}

export function getBot(id) {
  return bots.find((b) => b.id === id) || null;
}

function toPublicBot(b) {
  const credKeys = {};
  for (const k of Object.keys(b.credentials || {})) credKeys[k] = "********";
  return {
    id: b.id,
    platform: b.platform,
    name: b.name,
    enabled: b.enabled,
    credentialKeys: credKeys,
    settings: b.settings || {},
    status: b.status || { running: false },
  };
}

export function decryptCredentials(bot) {
  const out = {};
  for (const [k, v] of Object.entries(bot.credentials || {})) out[k] = decrypt(v);
  return out;
}

export function upsertBot(bot) {
  const idx = bots.findIndex((b) => b.id === bot.id);
  if (idx >= 0) bots[idx] = bot;
  else bots.push(bot);
  persistBots();
  return bot;
}

export function deleteBot(id) {
  const before = bots.length;
  bots = bots.filter((b) => b.id !== id);
  if (bots.length !== before) persistBots();
  return bots.length !== before;
}

function persistBots() {
  writeJson(botsFile, bots);
}

export function makeBot({ platform, name, credentials, settings }) {
  const id = crypto.randomUUID();
  const enc = {};
  for (const [k, v] of Object.entries(credentials || {})) enc[k] = encrypt(v);
  return {
    id,
    platform,
    name: name || platform,
    enabled: false,
    credentials: enc,
    settings: settings || {},
    status: { running: false },
  };
}

export function updateBotStatus(id, patch) {
  const b = getBot(id);
  if (!b) return;
  b.status = { ...(b.status || {}), ...patch, updatedAt: Date.now() };
  persistBots();
}

// Re-encrypt and replace a bot's credentials (used when a Weixin account finishes QR login).
export function setBotCredentials(id, credentials) {
  const b = getBot(id);
  if (!b) return null;
  const enc = {};
  for (const [k, v] of Object.entries(credentials || {})) enc[k] = encrypt(v);
  b.credentials = enc;
  persistBots();
  return b;
}

// ---------- Per-bot DeerFlow identity (who connected this bot) ----------
//
// A bot bound by a logged-in DeerFlow user carries that user's id plus a PAT
// minted for them. core/conversation.js uses this PAT instead of the global
// config.pat, so every thread the bot creates is owned by the user who
// connected it — which is what makes "each user sees only their own threads"
// work in the DeerFlow web UI (threads are filtered by the logged-in user).
//
// The PAT is stored as a credential so it is encrypted at rest by encrypt()
// and masked to "********" by toPublicBot's credentialKeys.
export function setBotDeerflowUser(id, { deerflowUserId, deerflowPat } = {}) {
  const b = getBot(id);
  if (!b) return null;
  if (deerflowUserId != null) b.deerflowUserId = String(deerflowUserId);
  if (deerflowPat != null) {
    b.credentials = b.credentials || {};
    b.credentials.__deerflowPat = encrypt(deerflowPat);
  }
  persistBots();
  return b;
}

// Returns the decrypted per-bot PAT, or null when this bot has none.
export function getBotDeerflowPat(id) {
  const b = getBot(id);
  if (!b || !b.credentials || !b.credentials.__deerflowPat) return null;
  return decrypt(b.credentials.__deerflowPat);
}

// dsh-im UI fields (persisted, non-secret). These mirror the shapes the vendored
// dsh-im React UI reads via normalizeBot/normalizeBotConnection.
export function setBotWorkspace(id, workspace) {
  const b = getBot(id);
  if (!b) return null;
  b.workspace = typeof workspace === "string" ? workspace.slice(0, 4096) : "";
  persistBots();
  return b;
}

export function setBotAgentPreset(id, agentPreset) {
  const b = getBot(id);
  if (!b) return null;
  b.agentPreset = agentPreset || "";
  // Keep the legacy runtime key in sync so core/conversation.js picks it up.
  b.settings = { ...(b.settings || {}), agent_name: agentPreset || "" };
  persistBots();
  return b;
}

export function setBotContextEnhancement(id, config) {
  const b = getBot(id);
  if (!b) return null;
  b.contextEnhancement = config || null;
  persistBots();
  return b;
}

export function setBotGroupResponseMode(id, mode) {
  const b = getBot(id);
  if (!b) return null;
  b.groupResponseMode = mode === "all" ? "all" : "mention";
  persistBots();
  return b;
}

// Plaintext per-bot runtime meta (non-secret): iLink get_updates cursor + seen message ids.
export function setBotMeta(id, meta) {
  const b = getBot(id);
  if (!b) return;
  b.meta = meta;
  persistBots();
}

export function getBotMeta(id) {
  const b = getBot(id);
  return b?.meta || null;
}

// ---------- Sessions (chat <-> DeerFlow thread) ----------

export function sessionKey(platform, botId, chatId, topicId) {
  return [platform, botId, chatId, topicId || ""].join("::");
}

export function getSession(platform, botId, chatId, topicId) {
  return sessions[sessionKey(platform, botId, chatId, topicId)] || null;
}

export function setSession(platform, botId, chatId, topicId, threadId, extra = {}) {
  sessions[sessionKey(platform, botId, chatId, topicId)] = {
    threadId,
    platform,
    botId,
    chatId,
    topicId: topicId || null,
    ...extra,
    updatedAt: Date.now(),
  };
  writeJson(sessionsFile, sessions);
}

export function clearSession(platform, botId, chatId, topicId) {
  const k = sessionKey(platform, botId, chatId, topicId);
  if (sessions[k]) {
    delete sessions[k];
    writeJson(sessionsFile, sessions);
  }
}

// ---------- Profiles (model/agent overrides via /model, /preset) ----------

function profileKey(platform, botId, chatId) {
  return [platform, botId, chatId].join("::");
}

export function getProfile(platform, botId, chatId) {
  return profiles[profileKey(platform, botId, chatId)] || null;
}

export function setProfile(platform, botId, chatId, patch) {
  const k = profileKey(platform, botId, chatId);
  profiles[k] = { ...(profiles[k] || {}), ...patch, updatedAt: Date.now() };
  writeJson(profilesFile, profiles);
  return profiles[k];
}

export function clearProfile(platform, botId, chatId) {
  const k = profileKey(platform, botId, chatId);
  if (profiles[k]) {
    delete profiles[k];
    writeJson(profilesFile, profiles);
  }
}
