import { Duplex } from "node:stream";
import tls from "node:tls";
import { Agent } from "undici";

function parseUuid(uuidStr: string): Buffer {
  const clean = uuidStr.replace(/-/g, "");
  return Buffer.from(clean, "hex");
}

function buildTransportHeader(
  uuidStr: string,
  targetHost: string,
  targetPort: number,
): Buffer {
  const uuidBuf = parseUuid(uuidStr);
  const hostBuf = Buffer.from(targetHost, "utf-8");
  const buf = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + 1 + hostBuf.length);
  let offset = 0;
  buf.writeUInt8(0, offset++); // version
  uuidBuf.copy(buf, offset);
  offset += 16;
  buf.writeUInt8(0, offset++); // addon length
  buf.writeUInt8(1, offset++); // command: 1 = TCP stream
  buf.writeUInt16BE(targetPort, offset);
  offset += 2;
  buf.writeUInt8(2, offset++); // address type: 2 = domain
  buf.writeUInt8(hostBuf.length, offset++);
  hostBuf.copy(buf, offset);
  return buf;
}

class GatewayDuplex extends Duplex {
  private _headerSent = false;
  private _respHeaderStripped = false;

  constructor(
    private ws: any,
    private key: string,
    private targetHost: string,
    private targetPort: number,
  ) {
    super();

    ws.onmessage = (event: any) => {
      let buf = Buffer.from(event.data);
      if (!this._respHeaderStripped) {
        this._respHeaderStripped = true;
        buf = buf.subarray(2);
      }
      if (buf.length > 0) {
        this.push(buf);
      }
    };

    ws.onclose = () => {
      this.push(null);
    };

    ws.onerror = (err: any) => {
      this.destroy(
        err instanceof Error ? err : new Error("Gateway connection error"),
      );
    };

    this.once("close", () => {
      if (ws.readyState === 1 || ws.readyState === 0) {
        try {
          ws.close();
        } catch {}
      }
    });
  }

  _write(
    chunk: any,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.ws.readyState !== 1 /* OPEN */) {
      return callback(new Error("Gateway socket not open"));
    }
    if (!this._headerSent) {
      this._headerSent = true;
      const header = buildTransportHeader(
        this.key,
        this.targetHost,
        this.targetPort,
      );
      this.ws.send(Buffer.concat([header, chunk]));
    } else {
      this.ws.send(chunk);
    }
    callback();
  }

  _read(): void {}
}

export function sanitizeGatewayUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "gateway-enabled";
  }
}

export function createGatewayConnector(gatewayUrl: string, gatewayKey: string) {
  const directAgent = new Agent();

  return function gatewayConnector(
    opts: any,
    callback: (err: Error | null, socket?: any) => void,
  ) {
    const { hostname, port, protocol, servername } = opts;
    const targetPort = Number(port) || (protocol === "https:" ? 443 : 80);

    const ws = new (globalThis as any).WebSocket(gatewayUrl, {
      dispatcher: directAgent,
    });
    ws.binaryType = "arraybuffer";

    let settled = false;
    const cleanup = () => {
      ws.onerror = null;
    };

    ws.onopen = () => {
      const rawStream = new GatewayDuplex(ws, gatewayKey, hostname, targetPort);
      if (protocol === "https:") {
        const tlsSocket = tls.connect({
          socket: rawStream,
          servername: servername || hostname,
          ALPNProtocols: ["http/1.1"],
        });

        tlsSocket.once("secureConnect", () => {
          if (!settled) {
            settled = true;
            cleanup();
            callback(null, tlsSocket);
          }
        });

        tlsSocket.on("error", (err) => {
          if (!settled) {
            settled = true;
            cleanup();
            callback(err);
          }
        });
      } else {
        if (!settled) {
          settled = true;
          cleanup();
          callback(null, rawStream);
        }
      }
    };

    ws.onerror = (err: any) => {
      if (!settled) {
        settled = true;
        cleanup();
        callback(
          err instanceof Error
            ? err
            : new Error("Gateway connection handshake failed"),
        );
      }
    };
  };
}

export function createGatewayAgent(options: {
  gatewayUrl: string;
  gatewayKey: string;
}): Agent {
  return new Agent({
    connect: createGatewayConnector(
      options.gatewayUrl,
      options.gatewayKey,
    ) as any,
    pipelining: 0,
  });
}
