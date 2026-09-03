// Minimal leveled logger.
import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, scope, args) {
  const threshold = LEVELS[config.logLevel] ?? 20;
  if (LEVELS[level] < threshold) return;
  const prefix = `[${level.toUpperCase()}]${scope ? ` ${scope}` : ""}`;
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](prefix, ...args);
}

export const logger = {
  debug: (scope, ...a) => log("debug", scope, a),
  info: (scope, ...a) => log("info", scope, a),
  warn: (scope, ...a) => log("warn", scope, a),
  error: (scope, ...a) => log("error", scope, a),
};
