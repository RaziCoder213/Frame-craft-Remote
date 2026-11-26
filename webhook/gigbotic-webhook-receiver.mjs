/**
 * Gigbotic encrypted v2 webhook receiver. Node.js 22+, no dependencies.
 * Setup: https://gigbotic.com/docs#webhook-security
 * Run behind an HTTPS reverse proxy. This example forwards verified wakeups
 * to your own authenticated runner/automation endpoint, which must durably
 * enqueue and deduplicate Idempotency-Key before responding with 2xx.
 */
import crypto from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyAndDecrypt({ rawBody, signature, secret, webhookId, nowSec = Math.floor(Date.now() / 1000) }) {
  const invalid = () => new Error("Invalid webhook delivery");
  try {
    if (!secret || !webhookId || Buffer.byteLength(rawBody) > 128_000) throw invalid();
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature ?? "");
    if (!match) throw invalid();
    const timestamp = Number(match[1]);
    if (!Number.isSafeInteger(timestamp) || Math.abs(nowSec - timestamp) > 300) throw invalid();
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
    if (!crypto.timingSafeEqual(Buffer.from(match[2], "hex"), expected)) throw invalid();
    const body = JSON.parse(rawBody);
    if (body.version !== 2 || body.algorithm !== "aes-256-gcm" || body.webhookId !== webhookId || typeof body.id !== "string") throw invalid();
    if (![body.iv, body.ciphertext, body.tag].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v))) throw invalid();
    const iv = Buffer.from(body.iv, "base64url");
    const tag = Buffer.from(body.tag, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw invalid();
    const key = Buffer.from(crypto.hkdfSync("sha256", secret, "", "gigbotic:webhook:v2:encryption", 32));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`gigbotic:webhook:v2:${webhookId}:${body.id}`, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(body.ciphertext, "base64url")), decipher.final()]);
    const notification = JSON.parse(plaintext.toString("utf8"));
    if (!notification || notification.webhookId !== webhookId || notification.id !== body.id) throw invalid();
    return notification;
  } catch { throw invalid(); }
}

const events = new Set([
  "job.queued",
  "job.client_replied",
  "job.revision_requested",
  "job.wakeup_triggered",
  "job.email_received",
  "job.activity_stale",
  "job.vault_updated",
  "job.wallet_resumed",
  "job.oauth_approval_decided",
  "job.cancel_requested",
  "job.oauth_event_received",
]);
const reply = (status, body) => Response.json(body, { status });

export function createWebhookHandler(config, forward = fetch) {
  if (!config.secret || !config.webhookId || !config.runnerUrl || !config.runnerToken) throw new Error("Configure the webhook ID, secret, runner URL, and runner token before starting.");
  const destination = new URL(config.runnerUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname);
  if ((destination.protocol !== "https:" && !(destination.protocol === "http:" && loopback)) || destination.username || destination.password || destination.hash) throw new Error("Runner URL must use HTTPS (HTTP is allowed only on loopback), without embedded credentials or fragments.");
  return async function handle(request) {
    if (new URL(request.url).pathname !== "/webhooks/gigbotic") return reply(404, { error: "Not found" });
    if (request.method !== "POST") return reply(405, { error: "Use POST" });
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > 128_000) return reply(413, { error: "Payload too large" });
    let notification;
    try {
      notification = verifyAndDecrypt({ rawBody, signature: request.headers.get("X-Gigbotic-Signature") ?? request.headers.get("X-Botwork-Signature"), secret: config.secret, webhookId: config.webhookId });
      if (config.creatorId && notification.creatorUserId !== config.creatorId) throw new Error("Wrong creator");
      if (notification.mcpEndpoint !== (config.mcpEndpoint ?? "https://gigbotic.com/mcp")) throw new Error("Wrong MCP server");
      if (notification.webhookAgentId && notification.agent?.id && notification.webhookAgentId !== notification.agent.id) throw new Error("Agent scope mismatch");
      if (config.agentId && notification.event !== "webhook.test" && notification.agent?.id !== config.agentId) throw new Error("Wrong agent");
      if (config.agentId && notification.webhookAgentId && notification.webhookAgentId !== config.agentId) throw new Error("Wrong webhook agent");
    } catch { return reply(401, { error: "Invalid webhook delivery" }); }
    // A console verification ping must never launch the fake sample job.
    if (notification.event === "webhook.test") return reply(200, { verified: true, version: 2 });
    if (!events.has(notification.event) || typeof notification.agent?.id !== "string" || typeof notification.job?.id !== "string" || typeof notification.wakeupPrompt !== "string") return reply(400, { error: "Invalid notification" });
    try {
      // The destination and credentials come only from trusted local config.
      // Its handler must authenticate this token and persist the idempotency key
      // before launching work. Keep MCP OAuth credentials on that runner.
      const response = await forward(destination, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.runnerToken}`, "Idempotency-Key": notification.id },
        body: JSON.stringify(notification),
      });
      await response.body?.cancel();
      if (!response.ok) return reply(502, { error: "Runner did not accept wakeup" });
      return reply(202, { accepted: true, deliveryId: notification.id });
    } catch { return reply(502, { error: "Runner unavailable" }); }
  };
}

export function startReceiver(env = process.env) {
  const handler = createWebhookHandler({
    secret: env.GIGBOTIC_WEBHOOK_SECRET, webhookId: env.GIGBOTIC_WEBHOOK_ID,
    creatorId: env.GIGBOTIC_CREATOR_ID, agentId: env.GIGBOTIC_AGENT_ID,
    mcpEndpoint: env.GIGBOTIC_MCP_ENDPOINT,
    runnerUrl: env.GIGBOTIC_RUNNER_URL, runnerToken: env.GIGBOTIC_RUNNER_TOKEN,
  });
  const port = Number(env.PORT ?? 3080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const server = http.createServer(async (incoming, outgoing) => {
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 128_000) { outgoing.writeHead(413).end(); incoming.resume(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const method = incoming.method ?? "GET";
      const request = new Request(new URL(incoming.url ?? "/", "http://localhost"), { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
      const result = await handler(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(port, "127.0.0.1", () => console.log(`Gigbotic receiver listening on 127.0.0.1:${port}; expose /webhooks/gigbotic through HTTPS.`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startReceiver();
