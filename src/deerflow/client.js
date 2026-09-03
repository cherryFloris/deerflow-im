// Thin client for the DeerFlow Gateway REST/SSE API.
// Only uses endpoints that the PAT allowlist permits (threads:read/write, runs:create/read).
//   POST /api/threads                       -> create thread
//   POST /api/threads/{id}/runs/stream      -> stream agent response (SSE)
//   POST /api/threads/{id}/history          -> fetch history (PAT-permitted; GET .../messages is NOT)
import { config } from "../config.js";
import { logger } from "../logger.js";

const ASSISTANT_ID = "lead_agent";

// Takes the PAT explicitly (rather than reading config.pat) so a client can act as
// a specific DeerFlow user — see clientForBot() in core/conversation.js, which
// passes the per-bot PAT minted for the user who connected that WeChat bot.
function authHeaders(pat) {
  return { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" };
}

function contentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).join("");
  }
  if (typeof content === "object" && "text" in content) return String(content.text || "");
  return "";
}

// Pull the LATEST AI/assistant message text out of a `values` SSE payload.
// DeerFlow emits the full channel state per `values` event, so callers must
// diff against what was already sent to avoid duplicating the answer.
function lastAiText(data) {
  if (!data || typeof data !== "object") return null;
  const msgs =
    data.values?.messages ||
    data.messages ||
    (Array.isArray(data) ? data : null);
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const item = msgs[i];
    const msg = Array.isArray(item) ? item[0] : item; // [message, metadata]
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.type || msg.role || "").toLowerCase();
    if (role.startsWith("ai") || role === "assistant") {
      const text = contentToString(msg.content);
      if (text) return text;
    }
  }
  return null;
}

export class DeerFlowClient {
  constructor({ gatewayUrl = config.gatewayUrl, pat = config.pat } = {}) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.pat = pat;
  }

  async createThread(assistantId = ASSISTANT_ID) {
    const resp = await fetch(`${this.gatewayUrl}/api/threads`, {
      method: "POST",
      headers: authHeaders(this.pat),
      body: JSON.stringify({ assistant_id: assistantId }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`DeerFlow createThread failed ${resp.status}: ${body}`);
    }
    const json = await resp.json();
    return json.thread_id;
  }

  async getHistory(threadId, limit = 50) {
    const resp = await fetch(`${this.gatewayUrl}/api/threads/${threadId}/history`, {
      method: "POST",
      headers: authHeaders(this.pat),
      body: JSON.stringify({ limit }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`DeerFlow getHistory failed ${resp.status}: ${body}`);
    }
    return resp.json();
  }

  /**
   * Stream a user message into a thread and invoke onToken(delta, isFinal) for each
   * assistant text delta. Resolves when the run completes.
   */
  async streamRun(threadId, text, opts = {}, onToken) {
    const { modelName, agentName, recursionLimit = config.defaultRecursionLimit } = opts;
    const context = {};
    if (modelName) context.model_name = modelName;
    if (agentName) context.agent_name = agentName;

    // Use the `values` stream mode: DeerFlow emits the full channel state per
    // event, and we send only the delta of the latest AI message (see lastAiText
    // + sentFull below). This avoids both the token-extraction miss and the
    // duplicate-text bug that the `messages-tuple` + full-state mix produced.
    const body = {
      assistant_id: ASSISTANT_ID,
      input: { messages: [{ role: "human", content: text }] },
      stream_mode: ["values"],
      config: { recursion_limit: recursionLimit },
    };
    if (Object.keys(context).length) body.context = context;

    const resp = await fetch(`${this.gatewayUrl}/api/threads/${threadId}/runs/stream`, {
      method: "POST",
      headers: authHeaders(this.pat),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`DeerFlow streamRun failed ${resp.status}: ${errBody}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawError = null;
    let sentFull = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = null;
        const dataLines = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        const dataStr = dataLines.join("").trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(dataStr);
        } catch {
          continue;
        }
        // `end` and heartbeat frames carry `data: null`; skip non-objects.
        if (json === null || typeof json !== "object") continue;
        if (event === "error" || json.error || (json.data && json.data.error)) {
          sawError = json.error || json.data?.error || "stream error";
          continue;
        }
        const full = lastAiText(json);
        if (typeof full === "string" && full.length > sentFull.length) {
          const delta = full.slice(sentFull.length);
          sentFull = full;
          if (delta && typeof onToken === "function") onToken(delta, false);
        }
      }
    }

    if (sawError) throw new Error(`DeerFlow run error: ${sawError}`);
    if (typeof onToken === "function") onToken("", true);
  }
}
