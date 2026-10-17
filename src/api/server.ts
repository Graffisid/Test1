/**
 * Webhook receiver (node:http, no framework). Routes:
 *   GET  /healthz         liveness, no internals
 *   GET  /webhooks/meta   Meta subscription verification (hub.verify_token → hub.challenge)
 *   POST /webhooks/meta   signed deliveries → signals
 *
 * Order of checks on POST: size limit → signature (HMAC over the raw bytes) → JSON parse → ingest.
 * Nothing unsigned is ever parsed or stored. Bodies are never logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { verifyMetaSignature } from "./meta-webhook.ts";
import { ingestMetaDelivery } from "../../workflows/ingest-comments.ts";

export interface IngestServerOptions {
  pool: pg.Pool;
  appSecret: string;
  verifyToken: string;
  ownIds: Set<string>;
  maxBodyBytes?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return reject(new TooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new TooLarge());
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createIngestServer(opts: IngestServerOptions): Server {
  const limit = opts.maxBodyBytes ?? 1_000_000;
  const log = opts.log ?? ((m, meta) => console.log(m, meta ?? ""));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") {
        return req.method === "GET" ? send(res, 200, "ok") : send(res, 405, "method not allowed");
      }
      if (url.pathname !== "/webhooks/meta") return send(res, 404, "not found");

      if (req.method === "GET") {
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        const ok = url.searchParams.get("hub.mode") === "subscribe"
          && sameSecret(url.searchParams.get("hub.verify_token") ?? "", opts.verifyToken)
          && /^[A-Za-z0-9_-]{1,128}$/.test(challenge);
        log(ok ? "meta subscription verified" : "meta subscription verification refused");
        return ok ? send(res, 200, challenge) : send(res, 403, "forbidden");
      }
      if (req.method !== "POST") return send(res, 405, "method not allowed");

      let raw: Buffer;
      try {
        raw = await readBody(req, limit);
      } catch (err) {
        if (err instanceof TooLarge) return send(res, 413, "payload too large");
        throw err;
      }
      if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, opts.appSecret)) {
        log("meta delivery refused: bad or missing signature", { bytes: raw.length });
        return send(res, 401, "invalid signature");
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, "invalid json");
      }
      const outcome = await ingestMetaDelivery(opts.pool, body, opts.ownIds);
      log("meta delivery ingested", { received: outcome.received, inserted: outcome.inserted,
        duplicates: outcome.duplicates, ignored: outcome.ignored.length });
      return send(res, 200, "EVENT_RECEIVED");
    } catch (err) {
      // 500 makes Meta retry; idempotency keys make the retry safe.
      log("ingest error", { error: (err as Error).message });
      if (!res.headersSent) send(res, 500, "error");
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return server;
}
