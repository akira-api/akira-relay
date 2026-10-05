const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function formatTime(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function formatRequestUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    if (parsed.pathname === "/v1/stream") {
      const u = parsed.searchParams.get("u");
      if (u) {
        try {
          const decoded = Buffer.from(u, "base64url").toString("utf-8");
          const target = new URL(decoded);
          const token = target.searchParams.get("token");
          let cleanDesc = `${target.hostname}${target.pathname}`;
          if (token) {
            cleanDesc += `?token=${token.slice(0, 8)}...`;
          }
          if (target.hash) {
            cleanDesc += target.hash;
          }
          return `/v1/stream [${cleanDesc}]`;
        } catch {
          return "/v1/stream [malformed-token]";
        }
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  private formatPrefix(level: LogLevel): string {
    const time = `${ANSI.gray}[${formatTime()}]${ANSI.reset}`;
    let badge = "";

    switch (level) {
      case "debug":
        badge = `${ANSI.cyan}[DEBUG]${ANSI.reset}`;
        break;
      case "info":
        badge = `${ANSI.green}[INFO]${ANSI.reset}`;
        break;
      case "warn":
        badge = `${ANSI.yellow}[WARN]${ANSI.reset}`;
        break;
      case "error":
        badge = `${ANSI.red}${ANSI.bold}[ERROR]${ANSI.reset}`;
        break;
    }

    return `${time} ${badge}`;
  }

  info(message: string, ...args: unknown[]): void {
    console.log(`${this.formatPrefix("info")} ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.formatPrefix("warn")} ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`${this.formatPrefix("error")} ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.debug(`${this.formatPrefix("debug")} ${message}`, ...args);
    }
  }

  http(
    method: string,
    url: string,
    status: number,
    durationMs: number,
    ip?: string,
  ): void {
    let statusColor = ANSI.green;
    if (status >= 400 && status < 500) statusColor = ANSI.yellow;
    if (status >= 500) statusColor = ANSI.red;

    const formattedUrl = formatRequestUrl(url);
    const ipStr = ip ? ` ${ANSI.gray}(${ip})${ANSI.reset}` : "";
    const durationStr = ` ${ANSI.gray}+${Math.round(durationMs)}ms${ANSI.reset}`;

    console.log(
      `${this.formatPrefix("info")} ${ANSI.cyan}${method}${ANSI.reset} ${formattedUrl} ${statusColor}${status}${ANSI.reset}${ipStr}${durationStr}`,
    );
  }

  request(_method: string, _url: string, _ip?: string): void {
    // Deprecated in favor of single-line http() on response
  }

  response(method: string, url: string, status: number, durationMs: number): void {
    this.http(method, url, status, durationMs);
  }
}

export const logger = new Logger();
