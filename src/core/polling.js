/**
 * Polling fallback for catching up after Mac sleep
 */

import { getToken, listActivities } from "../integrations/strava.js";
import { loadState, saveState, markProcessed } from "../storage/store.js";
import { handleActivityId } from "./activity-handler.js";

const {
  POLL_ENABLED = "true",
  POLL_INTERVAL_SEC = "600",
  POLL_LOOKBACK_HOURS = "24",
  POLL_PAGE_LIMIT = "4",
} = process.env;

export async function pollNewActivities() {
  const state = loadState();
  const now = Date.now();

  const lookbackMs = Number(POLL_LOOKBACK_HOURS) * 3600 * 1000;
  const afterMs = state.lastCheckedAt ? state.lastCheckedAt - 5 * 60 * 1000 : now - lookbackMs;
  const afterUnix = Math.floor(afterMs / 1000);

  const token = await getToken();

  const pageLimit = Math.max(1, Number(POLL_PAGE_LIMIT || "4"));
  let page = 1;
  let fetchedAny = false;

  while (page <= pageLimit) {
    const list = await listActivities(token, { after: afterUnix, page });

    if (!Array.isArray(list) || list.length === 0) break;
    fetchedAny = true;

    for (const a of list) {
      const id = a?.id;
      if (!id) continue;

      if (state.processed[String(id)]) continue;

      try {
        await handleActivityId(id, "poll");
        markProcessed(state, id);
        saveState(state);
      } catch (e) {
        console.error("poll handle error:", e?.response?.data || e.message);
      }
    }

    if (list.length < 50) break;
    page += 1;
  }

  state.lastCheckedAt = now;
  saveState(state);
}

export function startPolling() {
  if (String(POLL_ENABLED).toLowerCase() !== "true") {
    return;
  }

  const intervalSec = Math.max(60, Number(POLL_INTERVAL_SEC || "600"));
  console.log(`🕵️ Polling enabled: every ${intervalSec}s`);

  pollNewActivities().catch((e) => console.error("poll boot error:", e?.response?.data || e.message));

  setInterval(() => {
    pollNewActivities().catch((e) => console.error("poll interval error:", e?.response?.data || e.message));
  }, intervalSec * 1000);
}
