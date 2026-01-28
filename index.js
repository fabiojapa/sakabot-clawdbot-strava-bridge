/**
 * Sakabot Clawdbot Strava Bridge
 * Main entry point - Express server + webhook + polling
 *
 * Requires package.json: { "type": "module" }
 * deps: express axios dotenv
 *
 * ENV (required):
 * PORT=3009
 * STRAVA_CLIENT_ID=...
 * STRAVA_CLIENT_SECRET=...
 * STRAVA_VERIFY_TOKEN=...          (webhook verify token you set on Strava app)
 * STRAVA_REFRESH_TOKEN=...         (your refresh token)
 * TELEGRAM_BOT_TOKEN=...
 * TELEGRAM_CHAT_ID=...
 * CLAWDBOT_GATEWAY_URL=http://127.0.0.1:18789
 * CLAWDBOT_HOOK_TOKEN=...          (must match clawdbot.json hooks.token)
 *
 * ENV (optional):
 * SEND_RAW_TELEGRAM=false          (also send the raw summary directly to Telegram)
 * STORE_PATH=./activity-store.jsonl
 * STATE_PATH=./state.json
 * POLL_ENABLED=true
 * POLL_INTERVAL_SEC=600            (10 min)
 * POLL_LOOKBACK_HOURS=24           (first run / safety net lookback)
 * POLL_PAGE_LIMIT=4                (pagination pages, each 50 activities)
 */

import express from "express";
import "dotenv/config";
import { handleActivityId } from "./src/core/activity-handler.js";
import { startPolling } from "./src/core/polling.js";
import { loadState, saveState, markProcessed } from "./src/storage/store.js";


const { PORT = "3009", STRAVA_VERIFY_TOKEN } = process.env;

const app = express();
app.use(express.json());

/* --------------------------------------------------
   Routes
-------------------------------------------------- */

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === STRAVA_VERIFY_TOKEN) {
    return res.json({ "hub.challenge": req.query["hub.challenge"] });
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // Respond immediately (Strava expects fast ack)
  res.send("ok");

  if (req.body.object_type !== "activity") return;
  const activityId = req.body.object_id;
  if (!activityId) return;

  // Idempotency using state
  const state = loadState();
  if (state.processed[String(activityId)]) return;

  try {
    await handleActivityId(activityId, "webhook");
    markProcessed(state, activityId);
    saveState(state);
  } catch (e) {
    console.error("webhook handle error:", e?.response?.data || e.message);
  }
});

/* --------------------------------------------------
   Start server + polling
-------------------------------------------------- */

app.listen(PORT, () => console.log(`🚀 Strava webhook listening on ${PORT}`));

startPolling();
