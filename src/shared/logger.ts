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

  request(method: string, url: string, ip?: string): void {
    const ipStr = ip ? ` ${ANSI.gray}(${ip})${ANSI.reset}` : "";
    console.log(
      `${this.formatPrefix("info")} ${ANSI.cyan}${method}${ANSI.reset} ${url}${ipStr}`,
    );
  }

  response(method: string, url: string, status: number, durationMs: number): void {
    let statusColor = ANSI.green;
    if (status >= 400 && status < 500) statusColor = ANSI.yellow;
    if (status >= 500) statusColor = ANSI.red;

    console.log(
      `${this.formatPrefix("info")} ${ANSI.cyan}${method}${ANSI.reset} ${url} ${statusColor}${status}${ANSI.reset} ${ANSI.gray}+${Math.round(durationMs)}ms${ANSI.reset}`,
    );
  }
}

export const logger = new Logger();
