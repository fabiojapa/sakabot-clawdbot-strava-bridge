/**
 * Clawdbot AI coaching integration
 */

import axios from "axios";

const {
  CLAWDBOT_GATEWAY_URL = "http://127.0.0.1:18789",
  CLAWDBOT_HOOK_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

export async function sendToClawdbotAgent(messageText, meta) {
  if (!CLAWDBOT_HOOK_TOKEN) throw new Error("Missing env var: CLAWDBOT_HOOK_TOKEN");

  const url = `${CLAWDBOT_GATEWAY_URL.replace(/\/$/, "")}/hooks/agent`;

  const body = {
    message: messageText,
    name: "Strava",
    sessionKey: "hook:strava",
    wakeMode: "now",
    deliver: true,
    channel: "telegram",
    to: TELEGRAM_CHAT_ID,
  };

  if (meta) body.meta = meta;

  await axios.post(url, body, {
    headers: { Authorization: `Bearer ${CLAWDBOT_HOOK_TOKEN}` },
    timeout: 15000,
  });
}
