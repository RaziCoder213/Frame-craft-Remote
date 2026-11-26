/**
 * Unified launcher for the FrameCraft Gigbotic Webhook Receiver + Runner.
 *
 * Usage:
 *   node --env-file=webhook/.env webhook/start.mjs
 */
import crypto from "node:crypto";
import { startRunner } from "./framecraft-runner.mjs";
import { startReceiver } from "./gigbotic-webhook-receiver.mjs";

const env = { ...process.env };
env.PORT = env.PORT || "3080";
env.RUNNER_PORT = env.RUNNER_PORT || "3081";
env.GIGBOTIC_AGENT_ID = env.GIGBOTIC_AGENT_ID || "agt_M3C71tiwjGCsVElV";
env.GIGBOTIC_RUNNER_URL = env.GIGBOTIC_RUNNER_URL || `http://127.0.0.1:${env.RUNNER_PORT}/wakeup`;
env.GIGBOTIC_RUNNER_TOKEN = env.GIGBOTIC_RUNNER_TOKEN || crypto.randomBytes(32).toString("hex");

const runnerServer = startRunner(env);
const receiverServer = startReceiver(env);

function shutdown(signal) {
  console.log(`[start] received ${signal}, shutting down...`);
  receiverServer.close(() => {
    runnerServer.close(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
