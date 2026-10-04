import { pipeline } from "node:stream";
import { Transform } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { request } from "undici";
import { RelayError } from "../shared/errors.js";
import type { Metrics } from "../shared/metrics.js";
import type { ResolvedStream } from "../resolve/types.js";

function createIdleTimeoutStream(
  timeoutMs: number,
  onTimeout: () => void,
): Transform {
  let timer: NodeJS.Timeout | null = null;

  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      onTimeout();
    }, timeoutMs);
    timer.unref();
  };

  resetTimer();

  return new Transform({
    transform(chunk, _encoding, callback) {
      resetTimer();
      callback(null, chunk);
    },
    flush(callback) {
      if (timer) clearTimeout(timer);
      callback();
    },
    destroy(err, callback) {
      if (timer) clearTimeout(timer);
      callback(err);
    },
  });
}

export interface RelayStreamOptions {
  req: FastifyRequest;
  reply: FastifyReply;
  stream: ResolvedStream;
  metrics?: Metrics;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export async function pipeVideoToClient(options: RelayStreamOptions): Promise<void> {
  const {
    req,
    reply,
    stream,
    metrics,
    idleTimeoutMs = 20000,
    connectTimeoutMs = 10000,
  } = options;

  const abortController = new AbortController();
  let firstByteSent = false;

  // Abort upstream immediately on client disconnect (anti bandwidth leak)
  const onClientClose = () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
    }
  };
  reply.raw.on("close", onClientClose);

  // Connection/connect timeout before first response
  const connectTimer = setTimeout(() => {
    if (!firstByteSent) {
      abortController.abort();
    }
  }, connectTimeoutMs);
  connectTimer.unref();

  const upstreamHeaders: Record<string, string> = {
    ...stream.headers,
  };

  // Forward client Range header for seeking; HEAD probes a single byte so we
  // only pay for headers instead of the full body.
  const isHead = req.method === "HEAD";
  const clientRange = req.headers.range;
  if (clientRange) {
    upstreamHeaders.range = clientRange;
  } else if (isHead) {
    upstreamHeaders.range = "bytes=0-0";
  }

  let upstreamRes;
  let currentUrl = stream.directUrl;
  const maxRedirects = 5;

  try {
    for (let i = 0; i <= maxRedirects; i++) {
      upstreamRes = await request(currentUrl, {
        method: "GET",
        headers: upstreamHeaders,
        signal: abortController.signal,
      });

      if (
        [301, 302, 303, 307, 308].includes(upstreamRes.statusCode) &&
        upstreamRes.headers.location
      ) {
        const nextLoc = Array.isArray(upstreamRes.headers.location)
          ? upstreamRes.headers.location[0]
          : upstreamRes.headers.location;
        currentUrl = new URL(nextLoc, currentUrl).toString();
        await upstreamRes.body.dump();
        if (i === maxRedirects) {
          throw new RelayError(
            "UPSTREAM_ERROR",
            "Exceeded maximum upstream redirects",
            502,
          );
        }
        continue;
      }
      break;
    }
  } catch (err: any) {
    clearTimeout(connectTimer);
    reply.raw.off("close", onClientClose);
    if (err instanceof RelayError) throw err;
    if (abortController.signal.aborted) {
      throw new RelayError(
        "UPSTREAM_ERROR",
        "Connection to upstream video server timed out",
        502,
      );
    }
    throw new RelayError(
      "UPSTREAM_ERROR",
      `Failed to connect to upstream video source: ${err.message}`,
      502,
    );
  } finally {
    clearTimeout(connectTimer);
  }

  if (!upstreamRes) {
    reply.raw.off("close", onClientClose);
    throw new RelayError(
      "UPSTREAM_ERROR",
      "Empty response from upstream video server",
      502,
    );
  }

  const { statusCode, headers: rawHeaders, body: upstreamBody } = upstreamRes;

  // Handle upstream error status codes before headers are sent
  if (statusCode === 404 || statusCode === 410) {
    upstreamBody.destroy();
    reply.raw.off("close", onClientClose);
    throw new RelayError(
      "VIDEO_UNAVAILABLE",
      `Upstream video resource not found (status ${statusCode})`,
      410,
      statusCode,
    );
  }

  if (statusCode >= 400) {
    upstreamBody.destroy();
    reply.raw.off("close", onClientClose);
    throw new RelayError(
      "UPSTREAM_ERROR",
      `Upstream video server responded with status ${statusCode}`,
      502,
      statusCode,
    );
  }

  // Response headers preparation
  const forwardHeaders: Record<string, string | number | string[]> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers":
      "Content-Range, Content-Length, Accept-Ranges, Content-Type",
  };

  if (rawHeaders["content-type"]) {
    forwardHeaders["content-type"] = rawHeaders["content-type"];
  }
  if (rawHeaders["content-length"]) {
    forwardHeaders["content-length"] = rawHeaders["content-length"];
  }
  if (rawHeaders["content-range"]) {
    forwardHeaders["content-range"] = rawHeaders["content-range"];
  }
  forwardHeaders["accept-ranges"] = rawHeaders["accept-ranges"] ?? "bytes";
  if (rawHeaders["last-modified"]) {
    forwardHeaders["last-modified"] = rawHeaders["last-modified"];
  }
  if (rawHeaders.etag) {
    forwardHeaders.etag = rawHeaders.etag;
  }

  if (isHead) {
    reply.raw.writeHead(headStatus(), headHeaders());
    upstreamBody.destroy();
    reply.raw.off("close", onClientClose);
    reply.raw.end();
    return;
  }

  // HEAD semantics: mirror what GET would return. Content-Length must describe
  // the full resource when the client did not ask for a range.
  function headStatus(): number {
    if (clientRange) return statusCode;
    return rawHeaders["content-range"] ? 200 : statusCode;
  }

  function headHeaders(): Record<string, string | number | string[]> {
    const out = { ...forwardHeaders };
    const cr = rawHeaders["content-range"];
    if (cr) {
      const m = /bytes\s+(\d+)-(\d+)\/(\d+)/.exec(String(cr));
      if (clientRange) {
        out["content-range"] = cr;
        if (m) out["content-length"] = Number(m[2]) - Number(m[1]) + 1;
      } else if (m) {
        delete out["content-range"];
        out["content-length"] = Number(m[3]);
      }
    }
    if (out["content-length"] === undefined && rawHeaders["content-length"]) {
      out["content-length"] = rawHeaders["content-length"];
    }
    return out;
  }

  const idleStream = createIdleTimeoutStream(idleTimeoutMs, () => {
    // Sliding idle timeout expired
    abortController.abort();
    upstreamBody.destroy();
    if (firstByteSent) {
      reply.raw.destroy();
    }
  });

  return new Promise<void>((resolve, reject) => {
    // Send status & headers to client
    reply.raw.writeHead(statusCode, forwardHeaders);

    const firstByteProbe = new Transform({
      transform(chunk, _encoding, callback) {
        firstByteSent = true;
        if (metrics) {
          metrics.streams.bytesStreamed += chunk.length;
        }
        callback(null, chunk);
      },
    });

    pipeline(upstreamBody, firstByteProbe, idleStream, reply.raw, (err) => {
      reply.raw.off("close", onClientClose);
      if (err) {
        if (firstByteSent) {
          // If error happened after first byte, forcibly close socket
          reply.raw.destroy(err);
          resolve();
        } else {
          reject(
            new RelayError(
              "UPSTREAM_ERROR",
              `Streaming pipeline failure: ${err.message}`,
              502,
            ),
          );
        }
      } else {
        resolve();
      }
    });
  });
}
