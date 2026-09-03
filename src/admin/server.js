// Admin HTTP API + static UI for managing multi-bot IM connections.
// This is the dsh-im-style "IM机器人" management surface, kept fully outside DeerFlow.
import express from "express";
import fs from "node:fs";
import * as store from "../store.js";
import { platformDescriptors, startBot, stopBot } from "../connectors/index.js";
import { beginLogin, getLoginStatus, cancelLogin } from "../connectors/weixin/index.js";
import { dispatchRpc } from "./dshImRpc.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");

function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  const h =
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") || req.headers["x-admin-token"];
  if (h && h === config.adminToken) return next();
  return res.status(401).json({ error: "admin token required" });
}

export function createAdminApp() {
  const app = express();
  app.use(express.json());

  // Serve the prebuilt dsh-im admin UI, injecting the admin token as a same-origin
  // global so the vendored React UI can authenticate its RPC calls (the dsh-im UI
  // reads window.IM_BRIDGE_ADMIN_TOKEN). Served dynamically so the token stays an
  // env-time secret rather than baked into the static bundle. Only the "/" and
  // "/index.html" documents are rewritten; /assets/* stay static.
  app.get(["/", "/index.html"], (_req, res) => {
    let html;
    try {
      html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
    } catch {
      return res.status(404).send("Admin UI not built. Run `npm run build:ui`.");
    }
    const token = config.adminToken || "";
    const injected = html.replace(
      "</head>",
      `<script>window.IM_BRIDGE_ADMIN_TOKEN=${JSON.stringify(token)};</script></head>`,
    );
    res.type("html").send(injected);
  });

  app.use(express.static(publicDir));

  app.get("/api/admin/platforms", (_req, res) => {
    res.json(platformDescriptors);
  });

  // ----- dsh-im Host RPC bridge -----
  // The vendored dsh-im React UI talks to a single transport that resolves to
  // { ok: true, value } | { ok: false, error }. This route implements that envelope
  // for the `weixin` and `feishu` channels (see admin/dshImRpc.js).
  app.post("/api/admin/rpc", requireAdmin, async (req, res) => {
    const { channel, endpoint, payload } = req.body || {};
    if (!channel || !endpoint) {
      return res.status(400).json({ error: "channel and endpoint are required" });
    }
    const result = await dispatchRpc(channel, endpoint, payload || {}, req.signal);
    // Errors from the Host contract are still HTTP 200 with { ok: false, error }.
    res.status(200).json(result);
  });

  // ----- Personal WeChat (iLink) QR-scan provisioning -----
  app.post("/api/admin/weixin/login/begin", requireAdmin, async (_req, res) => {
    try {
      const attempt = await beginLogin();
      res.status(201).json(attempt);
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  app.get("/api/admin/weixin/login/:attemptId", requireAdmin, (req, res) => {
    const attempt = getLoginStatus(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: "login attempt not found" });
    res.json(attempt);
  });

  app.post("/api/admin/weixin/login/:attemptId/cancel", requireAdmin, async (req, res) => {
    try {
      const attempt = await cancelLogin(req.params.attemptId);
      res.json(attempt || { status: "cancelled" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/bots", (_req, res) => {
    res.json(store.listBots());
  });

  app.post("/api/admin/bots", requireAdmin, async (req, res) => {
    try {
      const { platform, name, credentials, settings, enabled } = req.body || {};
      if (!platformDescriptors[platform]) return res.status(400).json({ error: "unknown platform" });
      // Personal WeChat uses QR-scan login, not static credentials.
      if (platform === "weixin") {
        return res.status(400).json({ error: "微信机器人请使用扫码绑定（POST /api/admin/weixin/login/begin）。" });
      }
      if (!credentials || typeof credentials !== "object")
        return res.status(400).json({ error: "credentials required" });
      const bot = store.makeBot({ platform, name, credentials, settings: settings || {} });
      bot.enabled = !!enabled;
      store.upsertBot(bot);
      if (bot.enabled) {
        try {
          await startBot(store.getBot(bot.id));
        } catch (e) {
          store.updateBotStatus(bot.id, { running: false, lastError: e.message });
        }
      }
      res.status(201).json(store.listBots().find((b) => b.id === bot.id));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/admin/bots/:id", requireAdmin, async (req, res) => {
    try {
      const bot = store.getBot(req.params.id);
      if (!bot) return res.status(404).json({ error: "bot not found" });
      const { name, credentials, settings, enabled } = req.body || {};
      if (name != null) bot.name = name;
      if (settings != null) bot.settings = { ...(bot.settings || {}), ...settings };
      if (credentials != null) {
        for (const [k, v] of Object.entries(credentials)) {
          if (v === "" || v == null) continue; // empty = keep existing
          bot.credentials[k] = encryptField(v);
        }
      }
      if (enabled != null) bot.enabled = !!enabled;
      store.upsertBot(bot);
      res.json(store.listBots().find((b) => b.id === bot.id));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/bots/:id", requireAdmin, async (req, res) => {
    try {
      await stopBot(req.params.id);
      const ok = store.deleteBot(req.params.id);
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/bots/:id/start", requireAdmin, async (req, res) => {
    try {
      const bot = store.getBot(req.params.id);
      if (!bot) return res.status(404).json({ error: "bot not found" });
      await startBot(bot);
      bot.enabled = true;
      store.upsertBot(bot);
      res.json({ ok: true, status: store.getBot(bot.id).status });
    } catch (e) {
      store.updateBotStatus(bot.id, { running: false, lastError: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/bots/:id/stop", requireAdmin, async (req, res) => {
    try {
      await stopBot(req.params.id);
      const bot = store.getBot(req.params.id);
      if (bot) {
        bot.enabled = false;
        store.upsertBot(bot);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return app;
}

// Re-encrypt a single credential field using the same scheme as store.makeBot.
function encryptField(v) {
  const { crypto } = globalThis;
  // Mirror store.js encryption without re-importing internals.
  if (!config.secret) return { __obf: true, v: Buffer.from(String(v), "utf8").toString("base64") };
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(config.secret).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(v), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { __enc: true, iv: iv.toString("base64"), tag: tag.toString("base64"), v: enc.toString("base64") };
}

export function startAdminServer() {
  const app = createAdminApp();
  app.listen(config.adminPort, () => {
    logger.info("admin", `IM bridge admin UI/API listening on :${config.adminPort}`);
    if (!config.adminToken) {
      logger.warn("admin", "IM_BRIDGE_ADMIN_TOKEN is not set; admin write operations are unauthenticated.");
    }
  });
}
