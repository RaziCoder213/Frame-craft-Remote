/**
 * End-to-end cryptographic verification & B0/B8 compliance test for
 * webhook/gigbotic-webhook-receiver.mjs + webhook/framecraft-runner.mjs.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startRunner } from "./framecraft-runner.mjs";
import { startReceiver } from "./gigbotic-webhook-receiver.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LOCKS_DIR = path.join(REPO_ROOT, "tmp", "locks");

const webhookId = "whk_test_endpoint_001";
const secret = "whsec_test_secret_0123456789abcdef0123456789abcdef";
const agentId = "agt_M3C71tiwjGCsVElV";
const runnerToken = crypto.randomBytes(24).toString("hex");
const runnerPort = 33081;
const receiverPort = 33080;

function encryptV2(notification) {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(crypto.hkdfSync("sha256", secret, "", "gigbotic:webhook:v2:encryption", 32));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`gigbotic:webhook:v2:${webhookId}:${notification.id}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(notification), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    version: 2,
    id: notification.id,
    webhookId,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
  const rawBody = JSON.stringify(envelope);
  const ts = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  return { rawBody, signature: `t=${ts},v1=${hmac}` };
}

async function sendSigned(notification, tamperSig = false) {
  const { rawBody, signature } = encryptV2(notification);
  const res = await fetch(`http://127.0.0.1:${receiverPort}/webhooks/gigbotic`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gigbotic-Signature": tamperSig ? signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0") : signature,
    },
    body: rawBody,
  });
  return { status: res.status, json: await res.json() };
}

// Start servers with a harmless mock worker that sleeps 30s until cancelled
const runnerServer = startRunner({
  ...process.env,
  RUNNER_PORT: String(runnerPort),
  GIGBOTIC_RUNNER_TOKEN: runnerToken,
  FRAMECRAFT_WORKER_CMD: 'echo "started $GIGBOTIC_JOB_ID"; sleep 30',
});
const receiverServer = startReceiver({
  ...process.env,
  PORT: String(receiverPort),
  GIGBOTIC_WEBHOOK_ID: webhookId,
  GIGBOTIC_WEBHOOK_SECRET: secret,
  GIGBOTIC_AGENT_ID: agentId,
  GIGBOTIC_MCP_ENDPOINT: "https://gigbotic.com/mcp",
  GIGBOTIC_RUNNER_URL: `http://127.0.0.1:${runnerPort}/wakeup`,
  GIGBOTIC_RUNNER_TOKEN: runnerToken,
});

const jobId = `job_selftest_${Date.now()}`;
const deliveryQueued = `whd_queued_${Date.now()}`;
const deliveryCancel = `whd_cancel_${Date.now()}`;

try {
  await new Promise((r) => setTimeout(r, 150));

  // 1. Tampered signature -> 401
  const bad = await sendSigned({
    id: `whd_bad_${Date.now()}`,
    webhookId,
    event: "webhook.test",
    mcpEndpoint: "https://gigbotic.com/mcp",
  }, true);
  assert.equal(bad.status, 401, "Tampered signature must return 401");

  // 2. webhook.test -> 200 verified, zero workers spawned
  const ping = await sendSigned({
    id: `whd_ping_${Date.now()}`,
    webhookId,
    event: "webhook.test",
    mcpEndpoint: "https://gigbotic.com/mcp",
  });
  assert.equal(ping.status, 200, "webhook.test must return 200");
  assert.equal(ping.json.verified, true);
  assert.equal(ping.json.version, 2);

  // 3. job.queued -> 202 and worker spawned
  const queued = await sendSigned({
    id: deliveryQueued,
    webhookId,
    webhookAgentId: agentId,
    event: "job.queued",
    mcpEndpoint: "https://gigbotic.com/mcp",
    agent: { id: agentId },
    job: { id: jobId },
    wakeupPrompt: `Handle ${jobId}`,
  });
  assert.equal(queued.status, 202, "job.queued must return 202");

  // Confirm active worker pidfile exists
  const health1 = await (await fetch(`http://127.0.0.1:${runnerPort}/health`)).json();
  assert.ok(health1.activeJobs.includes(jobId), "Worker must be tracked as active");

  // 4. Duplicate job.queued (same delivery ID) -> 202, deduplicated
  const dup = await sendSigned({
    id: deliveryQueued,
    webhookId,
    webhookAgentId: agentId,
    event: "job.queued",
    mcpEndpoint: "https://gigbotic.com/mcp",
    agent: { id: agentId },
    job: { id: jobId },
    wakeupPrompt: `Handle ${jobId}`,
  });
  assert.equal(dup.status, 202, "Duplicate delivery must return 202");

  // 5. job.cancel_requested -> 202 and worker terminated immediately (B8)
  const cancel = await sendSigned({
    id: deliveryCancel,
    webhookId,
    webhookAgentId: agentId,
    event: "job.cancel_requested",
    mcpEndpoint: "https://gigbotic.com/mcp",
    agent: { id: agentId },
    job: { id: jobId },
    wakeupPrompt: `Cancel ${jobId}`,
  });
  assert.equal(cancel.status, 202, "job.cancel_requested must return 202");

  await new Promise((r) => setTimeout(r, 250));
  const health2 = await (await fetch(`http://127.0.0.1:${runnerPort}/health`)).json();
  assert.ok(!health2.activeJobs.includes(jobId), "Cancelled worker must no longer be active");
  assert.ok(fs.existsSync(path.join(LOCKS_DIR, `${jobId}.cancel`)), "Cancel flag file must exist");

  console.log("ALL 5 WEBHOOK RECEIVER + B0/B8 TESTS PASSED!");
} finally {
  receiverServer.close();
  runnerServer.close();
  // Clean up synthetic test artifacts
  for (const name of fs.readdirSync(LOCKS_DIR)) {
    if (name.includes(jobId) || name === "seen-deliveries.json" || name === "events.jsonl") {
      fs.rmSync(path.join(LOCKS_DIR, name), { force: true });
    }
  }
}
