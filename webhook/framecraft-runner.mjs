/**
 * FrameCraft B0/B8-compliant downstream webhook runner.
 *
 * Receives verified, decrypted Gigbotic notifications from
 * gigbotic-webhook-receiver.mjs, enforces Bearer authentication, persists
 * idempotency keys, logs every event durably, enforces single-runner-per-job
 * locking (B0), kills active workers immediately on job.cancel_requested (B8),
 * and optionally dispatches an isolated worker command (FRAMECRAFT_WORKER_CMD).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LOCKS_DIR = path.join(REPO_ROOT, "tmp", "locks");
const SEEN_FILE = path.join(LOCKS_DIR, "seen-deliveries.json");
const QUEUE_FILE = path.join(LOCKS_DIR, "events.jsonl");

function ensureLocksDir() {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
}

function loadSeenSet() {
  ensureLocksDir();
  try {
    const raw = fs.readFileSync(SEEN_FILE, "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSeenSet(seenSet) {
  ensureLocksDir();
  const entries = Array.from(seenSet).slice(-5000);
  const tmp = `${SEEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SEEN_FILE);
}

function safeId(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(jobId) {
  const lockPath = path.join(LOCKS_DIR, `${safeId(jobId)}.pid`);
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (isPidAlive(pid)) return { pid, lockPath };
    fs.rmSync(lockPath, { force: true });
  } catch {
    // No active lock
  }
  return { pid: null, lockPath };
}

function timingSafeBearerMatch(authHeader, expectedToken) {
  if (!authHeader || !expectedToken) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const supplied = Buffer.from(authHeader.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(supplied, expected);
}

export function startRunner(env = process.env) {
  const runnerToken = env.GIGBOTIC_RUNNER_TOKEN;
  if (!runnerToken) throw new Error("GIGBOTIC_RUNNER_TOKEN is required.");

  const runnerPort = Number(env.RUNNER_PORT ?? 3081);
  if (!Number.isInteger(runnerPort) || runnerPort < 1 || runnerPort > 65535) {
    throw new Error("Invalid RUNNER_PORT");
  }

  const workerCmd = (env.FRAMECRAFT_WORKER_CMD ?? "").trim();
  const seenDeliveries = loadSeenSet();
  const activeWorkers = new Map(); // jobId -> ChildProcess

  function killJobWorker(jobId, reason) {
    ensureLocksDir();
    const cancelFlagPath = path.join(LOCKS_DIR, `${safeId(jobId)}.cancel`);
    fs.writeFileSync(
      cancelFlagPath,
      JSON.stringify({ jobId, reason, cancelledAt: new Date().toISOString() }),
      { mode: 0o600 }
    );

    const child = activeWorkers.get(jobId);
    if (child && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited
        }
      }
      setTimeout(() => {
        if (isPidAlive(child.pid)) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already exited
          }
        }
      }, 2000).unref();
      activeWorkers.delete(jobId);
    }

    const { pid, lockPath } = readLockPid(jobId);
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already exited
        }
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  function spawnJobWorker(notification) {
    const jobId = notification.job.id;
    const agentId = notification.agent.id;
    const event = notification.event;

    if (event === "job.cancel_requested") {
      killJobWorker(jobId, "job.cancel_requested");
      return { dispatched: true, action: "cancelled" };
    }

    const { pid, lockPath } = readLockPid(jobId);
    if (pid) {
      return { dispatched: false, action: "already_running", pid };
    }

    // Clear any stale cancel flag only if a fresh job event arrives
    const cancelFlagPath = path.join(LOCKS_DIR, `${safeId(jobId)}.cancel`);
    if (event !== "job.cancel_requested") {
      fs.rmSync(cancelFlagPath, { force: true });
    }

    if (!workerCmd) {
      return { dispatched: false, action: "queued_without_worker_cmd" };
    }

    ensureLocksDir();
    const payloadPath = path.join(LOCKS_DIR, `${safeId(jobId)}-${safeId(notification.id)}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify(notification, null, 2), { mode: 0o600 });

    const child = spawn("bash", ["-lc", workerCmd], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        GIGBOTIC_EVENT: event,
        GIGBOTIC_DELIVERY_ID: notification.id,
        GIGBOTIC_AGENT_ID: agentId,
        GIGBOTIC_JOB_ID: jobId,
        GIGBOTIC_WAKEUP_PROMPT: notification.wakeupPrompt ?? "",
        GIGBOTIC_NOTIFICATION_FILE: payloadPath,
        GIGBOTIC_CANCEL_FLAG_FILE: cancelFlagPath,
      },
    });

    if (child.pid) {
      fs.writeFileSync(lockPath, String(child.pid), { mode: 0o600 });
      activeWorkers.set(jobId, child);
    }

    const logPath = path.join(LOCKS_DIR, `${safeId(jobId)}.worker.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    child.on("exit", (code, signal) => {
      logStream.end();
      if (activeWorkers.get(jobId) === child) activeWorkers.delete(jobId);
      try {
        const current = fs.readFileSync(lockPath, "utf8").trim();
        if (current === String(child.pid)) fs.rmSync(lockPath, { force: true });
      } catch {
        // Already removed
      }
      console.log(`[runner] worker exited job=${jobId} event=${event} code=${code} signal=${signal}`);
    });

    return { dispatched: true, action: "spawned", pid: child.pid };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, activeJobs: Array.from(activeWorkers.keys()) }));
      return;
    }

    if (url.pathname !== "/wakeup") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Use POST" }));
      return;
    }

    if (!timingSafeBearerMatch(req.headers.authorization, runnerToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256_000) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      chunks.push(chunk);
    }

    let notification;
    try {
      notification = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const deliveryId = String(req.headers["idempotency-key"] ?? notification.id ?? "");
    const agentId = notification?.agent?.id ?? "";
    const jobId = notification?.job?.id ?? "";
    const event = notification?.event ?? "";

    if (!deliveryId || !agentId || !jobId || !event) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required notification fields" }));
      return;
    }

    // B0 delivery deduplication fingerprint
    const fingerprint = `${deliveryId}:${agentId}:${jobId}:${event}`;
    if (seenDeliveries.has(fingerprint)) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, duplicate: true, deliveryId }));
      return;
    }

    seenDeliveries.add(fingerprint);
    saveSeenSet(seenDeliveries);

    // Durable event log before replying 202
    ensureLocksDir();
    fs.appendFileSync(
      QUEUE_FILE,
      JSON.stringify({
        receivedAt: new Date().toISOString(),
        deliveryId,
        event,
        agentId,
        jobId,
        wakeupPrompt: notification.wakeupPrompt ?? "",
      }) + "\n",
      { mode: 0o600 }
    );

    const outcome = spawnJobWorker(notification);
    console.log(`[runner] accepted delivery=${deliveryId} event=${event} job=${jobId} outcome=${outcome.action}`);

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, deliveryId, ...outcome }));
  });

  server.listen(runnerPort, "127.0.0.1", () => {
    console.log(`[runner] FrameCraft runner listening on 127.0.0.1:${runnerPort}/wakeup`);
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startRunner();
}
