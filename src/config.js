// Runtime configuration, sourced from environment variables.
// No DeerFlow source is touched; this service only needs a PAT for the Gateway.
import { logger } from "./logger.js";

export const config = {
  // DeerFlow Gateway base URL. Inside the docker-compose network this is
  // http://gateway:8001. From a local dev machine it can be http://localhost:8001.
  gatewayUrl: (process.env.DEERFLOW_GATEWAY_URL || "http://gateway:8001").replace(/\/$/, ""),

  // Personal Access Token issued from DeerFlow Gateway
  // (Settings -> Security -> Personal Access Tokens, scopes threads:read/write, runs:create/read).
  // Sent as `Authorization: Bearer <pat>`. PAT routes are CSRF-exempt.
  pat: process.env.DEERFLOW_PAT || "",

  // Port for the bridge admin API + UI.
  adminPort: parseInt(process.env.IM_BRIDGE_PORT || "8080", 10),

  // Optional token required for admin write operations (create/update/delete/start/stop bots).
  // If unset, the admin API is open (acceptable on a trusted LAN; set it for shared deployments).
  adminToken: process.env.IM_BRIDGE_ADMIN_TOKEN || "",

  // Secret used to encrypt credentials at rest (local-first security, mirrors dsh-im).
  // If unset, credentials are stored obfuscated-only (base64) with a warning. Set a strong value.
  secret: process.env.IM_BRIDGE_SECRET || "",

  // Directory for persisted JSON state (bots, sessions). Mount a volume in docker.
  dataDir: process.env.IM_BRIDGE_DATA_DIR || "./data",

  // Default recursion limit used when a bot does not override it. DeerFlow clamps to <= 1000.
  defaultRecursionLimit: parseInt(process.env.IM_BRIDGE_RECURSION_LIMIT || "100", 10),

  logLevel: (process.env.IM_BRIDGE_LOG_LEVEL || "info").toLowerCase(),
};

// The global PAT is now a fallback only, not a hard startup requirement.
//
// WeChat bots bound by a logged-in DeerFlow user carry their own per-bot PAT
// (see store.setBotDeerflowUser / admin/server.js auto-signing), so those bots
// work without a global PAT. It is still required as the fallback for bots
// without a per-bot PAT (e.g. Feishu, or a WeChat bot bound by an admin token
// with no DeerFlow session), so only warn here and let the actual call fail
// with a clear error if neither is available.
export function requirePat() {
  if (!config.pat) {
    logger.warn(
      "config",
      "DEERFLOW_PAT is not set. WeChat bots bound by a logged-in DeerFlow user will use their " +
        "per-bot PAT; bots without one (e.g. Feishu) will fail until DEERFLOW_PAT is set " +
        "(POST /api/v1/auth/pats, scopes threads:read threads:write runs:create runs:read)."
    );
  }
  return config.pat;
}
