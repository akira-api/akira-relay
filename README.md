# akira-relay

Lightweight video stream relay and resolver service designed to stream media from IP-restricted upstreams.

## Features

- **Direct Stream Relay**: Pipes upstream bytes with backpressure and auto-destruction on client disconnect.
- **Range Support**: Forwards HTTP `Range` headers to support seeking (`206 Partial Content`).
- **Batch Hybrid Resolver**: Resolves multiple sources in parallel per quality with sequential fallback intra-quality, returning signed `/v1/stream` URLs.
- **Token Authorization**: Verifies HMAC-SHA256 signed URLs offline with timing-safe checks.
- **Persistent SQLite Cache**: Zero-dependency SQLite (`node:sqlite`) cache (default 2 hours TTL), single-flight dedup, negative caching for dead videos, and stale-while-error fallback.
- **Guardrails**: Global and per-IP concurrency limits, sliding read-idle timeouts, and token-bucket rate limits.
- **Metrics**: Runtime stats endpoint for external dashboards.

## API Specification

### `POST /internal/resolve` (or `POST /v1/resolve`)

Batch resolver for Akira backend. Accepts candidate sources grouped by quality, runs hybrid resolution (parallel across qualities, sequential fallback within each quality), and returns signed `/v1/stream` URLs.

- **Auth**: Send `X-Relay-Key: <key>` header or `Authorization: Bearer <key>` (checked when `INTERNAL_RELAY_KEY` is configured).

#### Request Body
```json
{
  "sources": [
    { "site": "acefile", "quality": "2160p", "url": "https://acefile.co/f/111" },
    { "site": "blogger", "quality": "2160p", "url": "https://www.blogger.com/video.g?token=aaa" },
    { "site": "acefile", "quality": "1080p", "url": "https://acefile.co/f/222" },
    { "site": "blogger", "quality": "720p",  "url": "https://www.blogger.com/video.g?token=bbb" }
  ]
}
```

#### Response (200 OK)
```json
{
  "streams": [
    {
      "quality": "2160p",
      "url": "/v1/stream?u=...&e=...&s=..."
    },
    {
      "quality": "1080p",
      "url": "/v1/stream?u=...&e=...&s=..."
    },
    {
      "quality": "720p",
      "url": "/v1/stream?u=...&e=...&s=..."
    }
  ]
}
```

Qualities where all candidates fail are automatically excluded from the output.

### `GET /v1/stream`

Streams video content from an upstream target.

#### Query Parameters
- `u`: Base64URL-encoded target URL
- `e`: Expiration timestamp (Unix epoch in seconds)
- `s`: HMAC-SHA256 signature generated with `RELAY_SECRET` over `${u}.${e}`

#### Signing URL (Node.js Example)
```ts
import { createHmac } from "node:crypto";

function signStreamUrl(targetUrl: string, secret: string, ttlSeconds = 7200) {
  const u = Buffer.from(targetUrl, "utf-8").toString("base64url");
  const e = Math.floor(Date.now() / 1000) + ttlSeconds;
  const s = createHmac("sha256", secret).update(`${u}.${e}`).digest("hex");
  return `/v1/stream?u=${u}&e=${e}&s=${s}`;
}
```

#### Success Responses
- `200 OK`: Full video stream.
- `206 Partial Content`: Partial stream when client sends a `Range` header (seeking). Response includes `Content-Range` and `Accept-Ranges`.

### `GET /internal/health`

Returns service health status for probes and orchestrators.

```json
{
  "status": "ok",
  "timestamp": 1710000000000
}
```

### `GET /internal/stats`

Runtime metrics (cache hit/miss, streams, limits, errors) for dashboards.

- Auth: send `X-Relay-Key` header — required only if `INTERNAL_RELAY_KEY` is set.

```json
{
  "uptimeSec": 3600,
  "memory": { "rssMB": 42, "heapUsedMB": 18 },
  "cache": { "size": 12, "hits": 95, "misses": 10, "negativeHits": 2, "staleHits": 1, "singleFlightJoins": 4, "evictions": 0 },
  "resolve": { "ok": 10, "failed": 1 },
  "streams": { "active": 3, "started": 50, "finished": 47, "bytesStreamed": 104857600 },
  "limits": { "activeGlobal": 3, "trackedIps": 2, "globalRejections": 0, "perIpRejections": 0, "rateLimitRejections": 1 },
  "errorsByCode": { "VIDEO_UNAVAILABLE": 1 }
}
```

## Error Handling

Errors encountered before sending the first byte return standard JSON responses:

```json
{
  "error": {
    "code": "VIDEO_UNAVAILABLE",
    "message": "Resource not found on upstream server",
    "upstreamStatus": 404
  }
}
```

If an error occurs after transmission begins, the connection closes immediately to signal the media player.

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `INVALID_TOKEN` | Missing or malformed query parameters |
| 403 | `INVALID_TOKEN` | Signature mismatch |
| 403 | `TOKEN_EXPIRED` | Token past its expiration time |
| 403 | `FORBIDDEN_TARGET` | Target host not in allowlist |
| 410 | `VIDEO_UNAVAILABLE` | Video removed upstream (negative-cached for 90s) |
| 429 | `RATE_LIMITED` | Per-IP concurrency or resolve rate limit exceeded (includes `Retry-After`) |
| 502 | `UPSTREAM_ERROR` | Upstream unreachable, timed out, or responded with an error |
| 503 | `SERVICE_UNAVAILABLE` | Global concurrent stream limit reached |

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SECRET` | — | HMAC secret for signing stream tokens (required) |
| `PORT` | `3000` | HTTP listen port |
| `RELAY_TUNNEL_TOKEN` | — | Cloudflare Tunnel token for the sidecar |
| `ALLOWLIST_HOSTS` | `acefile.co,blogger.com,...` | Comma-separated permitted target hosts |
| `MAX_CONCURRENT_STREAMS` | `150` | Global concurrent stream cap |
| `RESOLVE_CACHE_TTL_MS` | `7200000` | SQLite resolve cache TTL (default: 2 hours) |
| `SQLITE_DB_PATH` | `./data/relay.db` | SQLite database file location |
| `IDLE_TIMEOUT_MS` | `20000` | Sliding read-idle timeout; stream destroyed if exceeded |
| `RESOLVE_TIMEOUT_MS` | `10000` | Upstream resolve/connect timeout before first byte |
| `INTERNAL_RELAY_KEY` | — | If set, `/internal/resolve` and `/internal/stats` require `X-Relay-Key` header |

## Project Structure

```
src/
├── server.ts           # Fastify bootstrap & config
├── routes/
│   ├── stream.ts       # GET /v1/stream
│   └── internal.ts     # /internal/resolve, /internal/health, /internal/stats
├── core/
│   ├── relay.ts        # pipeline, Range, idle timeout, abort
│   ├── token.ts        # HMAC sign/verify (timing-safe)
│   └── limit.ts        # concurrency + per-IP rate limit
├── resolve/
│   ├── index.ts        # allowlist, cache orchestration, single-flight
│   ├── acefile.ts      # acefile player extractor & probe
│   ├── blogger.ts      # blogger batchexecute extractor, quality matching & probe
│   ├── cache.ts        # SQLite persistent cache + single-flight
│   └── types.ts
└── shared/
    ├── errors.ts       # error codes → JSON response
    ├── logger.ts       # colored console logger
    └── metrics.ts      # counters for /internal/stats
```

## Getting Started

### Prerequisites
- Node.js 22+
- Docker & Docker Compose (optional)

### Local Setup

```bash
# Copy environment configuration
cp .env.example .env

# Install dependencies
npm install

# Run development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

### Manual Stream Test

```bash
npx tsx scripts/test-stream.ts "<TARGET_URL>"
```

Prints a signed stream URL to open in the browser.

### Docker Deployment

```bash
docker compose up -d --build
```

Runs the relay plus a `cloudflared` sidecar (`RELAY_TUNNEL_TOKEN`) with a container memory limit of 1G and a healthcheck against `/internal/health`.

