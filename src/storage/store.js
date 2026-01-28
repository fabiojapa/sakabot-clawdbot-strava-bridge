/**
 * Storage layer (JSONL + state file)
 */

import fs from "fs";
import path from "path";
import { safeNum } from "../utils/formatters.js";
import { isPaceBased, avgPaceSecPerKm, avgSpeedKmh, pctDiff } from "../utils/stream-analysis.js";

const { STORE_PATH = "./activity-store.jsonl", STATE_PATH = "./state.json" } = process.env;

function ensureDir(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function appendStore(record) {
  ensureDir(STORE_PATH);
  fs.appendFileSync(STORE_PATH, JSON.stringify(record) + "\n", "utf8");
}

export function readStore(limit = 2000) {
  if (!fs.existsSync(STORE_PATH)) return [];
  const content = fs.readFileSync(STORE_PATH, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - limit));
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastCheckedAt: 0, processed: {} };
  }
}

export function saveState(state) {
  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function pruneProcessed(state, maxItems = 4000) {
  const entries = Object.entries(state.processed || {});
  if (entries.length <= maxItems) return;
  entries.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0)); // oldest first
  const toDelete = entries.length - maxItems;
  for (let i = 0; i < toDelete; i++) delete state.processed[entries[i][0]];
}

export function markProcessed(state, id) {
  state.processed[String(id)] = Date.now();
  pruneProcessed(state);
}

export function pickComparableLastWeek(current, history) {
  // 7–14 days window, same activity.type, similar distance ±20%

  const curStart = new Date(current.activity.start_date_local ?? current.activity.start_date ?? Date.now());
  if (Number.isNaN(curStart.getTime())) return null;

  const startMax = new Date(curStart.getTime() - 7 * 24 * 3600 * 1000);
  const startMin = new Date(curStart.getTime() - 14 * 24 * 3600 * 1000);

  const curType = current.activity.type;
  const curDist = safeNum(current.activity.distance_m);

  const candidates = history
    .filter((r) => r?.activity?.id && r.activity.id !== current.activity.id)
    .filter((r) => r?.activity?.type === curType)
    .filter((r) => {
      const dt = new Date(r.activity.start_date_local ?? r.activity.start_date ?? 0);
      if (Number.isNaN(dt.getTime())) return false;
      return dt >= startMin && dt <= startMax;
    })
    .filter((r) => {
      if (curDist == null) return true;
      const d = safeNum(r.activity.distance_m);
      if (d == null || d <= 0) return false;
      return Math.abs(d - curDist) / curDist <= 0.2;
    })
    .sort((a, b) => {
      const da = new Date(a.activity.start_date_local ?? a.activity.start_date ?? 0).getTime();
      const db = new Date(b.activity.start_date_local ?? b.activity.start_date ?? 0).getTime();
      return db - da;
    });

  return candidates[0] ?? null;
}

export function compareCurrentVsPrev(current, prev) {
  if (!prev) return null;

  const cur = current.activity;
  const old = prev.activity;

  const paceBased = isPaceBased(cur.type, cur.sport_type);

  const curPace = paceBased ? avgPaceSecPerKm(cur.distance_m, cur.moving_time_s) : null;
  const oldPace = paceBased ? avgPaceSecPerKm(old.distance_m, old.moving_time_s) : null;

  const curSpeed = !paceBased ? avgSpeedKmh(cur.distance_m, cur.moving_time_s) : null;
  const oldSpeed = !paceBased ? avgSpeedKmh(old.distance_m, old.moving_time_s) : null;

  const curHrAvg = safeNum(current.derived?.hr_avg_stream ?? cur.average_heartrate);
  const oldHrAvg = safeNum(prev.derived?.hr_avg_stream ?? old.average_heartrate);

  const curHrMax = safeNum(current.derived?.hr_max_stream ?? null);
  const oldHrMax = safeNum(prev.derived?.hr_max_stream ?? null);

  const curPwr = safeNum(current.derived?.power_avg ?? cur.average_watts);
  const oldPwr = safeNum(prev.derived?.power_avg ?? old.average_watts);

  return {
    prev_activity_id: old.id,
    prev_start_date_local: old.start_date_local ?? old.start_date ?? null,
    mode: paceBased ? "pace" : "speed",
    delta: {
      distance_m:
        safeNum(cur.distance_m) != null && safeNum(old.distance_m) != null ? cur.distance_m - old.distance_m : null,
      moving_time_s:
        safeNum(cur.moving_time_s) != null && safeNum(old.moving_time_s) != null ? cur.moving_time_s - old.moving_time_s : null,
      elevation_gain_m:
        safeNum(cur.total_elevation_gain_m) != null && safeNum(old.total_elevation_gain_m) != null
          ? cur.total_elevation_gain_m - old.total_elevation_gain_m
          : null,

      // pace: negative = faster
      avg_pace_sec_per_km: curPace != null && oldPace != null ? curPace - oldPace : null,
      avg_pace_pct: curPace != null && oldPace != null ? pctDiff(curPace, oldPace) : null,

      // speed: positive = faster
      avg_speed_kmh: curSpeed != null && oldSpeed != null ? curSpeed - oldSpeed : null,
      avg_speed_pct: curSpeed != null && oldSpeed != null ? pctDiff(curSpeed, oldSpeed) : null,

      hr_avg: curHrAvg != null && oldHrAvg != null ? curHrAvg - oldHrAvg : null,
      hr_max: curHrMax != null && oldHrMax != null ? curHrMax - oldHrMax : null,

      power_avg_w: curPwr != null && oldPwr != null ? curPwr - oldPwr : null,
      power_avg_pct: curPwr != null && oldPwr != null ? pctDiff(curPwr, oldPwr) : null,
    },
  };
}
