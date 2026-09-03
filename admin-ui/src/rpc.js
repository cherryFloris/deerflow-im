// Front-end transport that satisfies the dsh-im React UI's contract:
//   rpcCall(channel, endpoint, payload, signal) -> Promise<{ ok, value } | { ok:false, error }>
// It POSTs to the im-bridge admin backend's /api/admin/rpc, which already returns the
// exact dsh-im Host envelope. Admin-token auth is injected from the same origin (the
// backend serves this page, so the token is supplied via a same-origin header set by
// the bridge/nginx; here we forward any x-admin-token present in the page context).
async function postRpc(channel, endpoint, payload, signal) {
  const headers = { "Content-Type": "application/json" };
  // Allow the host page to embed a token (e.g. via window.IM_BRIDGE_ADMIN_TOKEN or a
  // cookie-free header). Falls back to no header; backend only enforces it if configured.
  const token =
    (typeof window !== "undefined" && window.IM_BRIDGE_ADMIN_TOKEN) ||
    (typeof document !== "undefined" && document.querySelector("meta[name=admin-token]")?.content);
  if (token) headers["x-admin-token"] = token;

  const resp = await fetch("/api/admin/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({ channel, endpoint, payload: payload || {} }),
    signal,
  });
  if (resp.status === 401) {
    return { ok: false, error: { code: "ADMIN_TOKEN_REQUIRED", message: "需要管理员令牌（admin token）。" } };
  }
  if (!resp.ok) {
    let message = `请求失败（${resp.status}）`;
    try {
      const body = await resp.json();
      if (body?.error) message = typeof body.error === "string" ? body.error : body.error.message || message;
    } catch {
      /* ignore */
    }
    return { ok: false, error: { code: "HTTP_ERROR", message } };
  }
  return resp.json();
}

export function makeRpcCall(channel) {
  return (endpoint, payload, signal) => postRpc(channel, endpoint, payload, signal);
}

export const weixinRpcCall = makeRpcCall("/weixin");
export const feishuRpcCall = makeRpcCall("/feishu");
