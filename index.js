// index.js
// Strava Webhook Bridge (Port 3009)
// Webhook + Fallback Polling (quando o Mac dorme) + Compare vs last week + Ride metrics (speed/power/etc)
// Sends coaching prompt to Clawdbot (/hooks/agent) and delivers reply to Telegram.
//
// Requires package.json: { "type": "module" }
// deps: express axios dotenv
//
// ENV (required):
// PORT=3009
// STRAVA_CLIENT_ID=...
// STRAVA_CLIENT_SECRET=...
// STRAVA_VERIFY_TOKEN=...          (webhook verify token you set on Strava app)
// STRAVA_REFRESH_TOKEN=...         (your refresh token)
// TELEGRAM_BOT_TOKEN=...
// TELEGRAM_CHAT_ID=...
// CLAWDBOT_GATEWAY_URL=http://127.0.0.1:18789
// CLAWDBOT_HOOK_TOKEN=...          (must match clawdbot.json hooks.token)
//
// ENV (optional):
// SEND_RAW_TELEGRAM=false          (also send the raw summary directly to Telegram)
// STORE_PATH=./activity-store.jsonl
// STATE_PATH=./state.json
// POLL_ENABLED=true
// POLL_INTERVAL_SEC=600            (10 min)
// POLL_LOOKBACK_HOURS=24           (first run / safety net lookback)
// POLL_PAGE_LIMIT=4                (pagination pages, each 50 activities)

import express from "express";
import axios from "axios";
import "dotenv/config";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const {
  PORT = "3009",

  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_VERIFY_TOKEN,
  STRAVA_REFRESH_TOKEN,

  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,

  CLAWDBOT_GATEWAY_URL = "http://127.0.0.1:18789",
  CLAWDBOT_HOOK_TOKEN,

  SEND_RAW_TELEGRAM = "false",
  STORE_PATH = "./activity-store.jsonl",
  STATE_PATH = "./state.json",

  POLL_ENABLED = "true",
  POLL_INTERVAL_SEC = "600",
  POLL_LOOKBACK_HOURS = "24",
  POLL_PAGE_LIMIT = "4",
} = process.env;

/* --------------------------------------------------
   Utils
-------------------------------------------------- */
function safeNum(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function secToHMS(sec) {
  if (!Number.isFinite(sec)) return "n/d";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function secToPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "n/d";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}
function msToKmh(ms) {
  if (!Number.isFinite(ms)) return null;
  return ms * 3.6;
}
function fmtKmh(kmh) {
  if (!Number.isFinite(kmh)) return "n/d";
  return `${kmh.toFixed(1)} km/h`;
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function htmlToPlainText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h\d>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function formatDateTimeLocal(iso) {
  if (!iso) return "n/d";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/d";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
function chunkText(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.6) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length) parts.push(rest);
  return parts.length > 1
    ? parts.map((p, i) => `<b>(${i + 1}/${parts.length})</b>\n${p}`)
    : parts;
}

function isPaceBased(activityType, sportType) {
  const t = String(activityType || "").toLowerCase();
  const s = String(sportType || "").toLowerCase();
  return (
    t.includes("run") ||
    t.includes("walk") ||
    t.includes("hike") ||
    s.includes("run") ||
    s.includes("walk") ||
    s.includes("hike")
  );
}

function avgPaceSecPerKm(distance_m, moving_time_s) {
  const dKm = safeNum(distance_m) != null ? distance_m / 1000 : null;
  const t = safeNum(moving_time_s);
  if (!dKm || !t || dKm <= 0 || t <= 0) return null;
  return t / dKm;
}
function avgSpeedKmh(distance_m, moving_time_s) {
  const d = safeNum(distance_m);
  const t = safeNum(moving_time_s);
  if (!d || !t || d <= 0 || t <= 0) return null;
  return msToKmh(d / t);
}
function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return (a - b) / b;
}

/* --------------------------------------------------
   Stream stats
-------------------------------------------------- */
function statsFromStream(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return { avg: null, max: null };
  const xs = arr.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (xs.length === 0) return { avg: null, max: null };
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const max = Math.max(...xs);
  return { avg, max };
}

/* --------------------------------------------------
   Splits (adaptive)
-------------------------------------------------- */
function computeSplits1km(streams, mode /* "pace" | "speed" */) {
  const dist = streams?.distance?.data;
  const time = streams?.time?.data;
  const hr = streams?.heartrate?.data;
  const watts = streams?.watts?.data;

  if (!dist || !time || dist.length !== time.length) return [];

  const splits = [];
  let nextKm = 1000;
  let startIdx = 0;

  for (let i = 0; i < dist.length; i++) {
    if (dist[i] >= nextKm) {
      const meters = dist[i] - dist[startIdx];
      const seconds = time[i] - time[startIdx];
      const speedMs = meters > 0 && seconds > 0 ? meters / seconds : null;
      const speedKmh = speedMs != null ? msToKmh(speedMs) : null;
      const secPerKm = meters > 0 && seconds > 0 ? seconds / (meters / 1000) : null;

      let hrAvg = null;
      let hrMax = null;
      if (hr && hr.length === dist.length) {
        const seg = hr.slice(startIdx, i + 1).filter(Number.isFinite);
        if (seg.length) {
          hrAvg = Math.round(seg.reduce((a, b) => a + b, 0) / seg.length);
          hrMax = Math.max(...seg);
        }
      }

      let pAvg = null;
      if (watts && watts.length === dist.length) {
        const seg = watts.slice(startIdx, i + 1).filter(Number.isFinite);
        if (seg.length) pAvg = Math.round(seg.reduce((a, b) => a + b, 0) / seg.length);
      }

      const label =
        mode === "pace"
          ? secToPace(secPerKm ?? NaN)
          : speedKmh != null
          ? fmtKmh(speedKmh)
          : "n/d";

      splits.push({
        km: splits.length + 1,
        mode,
        meters,
        seconds,
        secPerKm: secPerKm ?? null,
        speedKmh: speedKmh ?? null,
        label,
        hrAvg,
        hrMax,
        powerAvg: pAvg,
      });

      startIdx = i;
      nextKm += 1000;
    }
  }
  return splits;
}

function pacingInsight(splits) {
  // only meaningful for pace-based activities (secPerKm)
  if (!Array.isArray(splits) || splits.length < 4) return null;
  const valid = splits.filter((s) => typeof s.secPerKm === "number" && Number.isFinite(s.secPerKm));
  if (valid.length < 4) return null;

  const mid = Math.floor(valid.length / 2);
  const avg = (arr) => arr.reduce((a, b) => a + b.secPerKm, 0) / arr.length;

  const first = avg(valid.slice(0, mid));
  const second = avg(valid.slice(mid));
  const diff = second - first;

  if (Math.abs(diff) < 5) return "Pacing estável";
  if (diff < 0) return "Negative split ✅";
  return "Fade ⚠️ (ritmo caiu)";
}

/* --------------------------------------------------
   Zones (optional)
-------------------------------------------------- */
function formatZones(zones) {
  if (!Array.isArray(zones)) return "";
  const blocks = [];

  for (const z of zones) {
    const buckets = z?.distribution_buckets;
    if (!Array.isArray(buckets)) continue;
    const total = buckets.reduce((a, b) => a + (b.time ?? 0), 0);
    if (!total) continue;

    const title =
      z.type === "heartrate" ? "❤️ Zonas FC" : z.type === "power" ? "⚡ Zonas Potência" : "⚡ Zonas";
    const line = buckets.map((b, i) => `Z${i + 1}: ${Math.round((b.time / total) * 100)}%`).join(" | ");

    blocks.push(`<b>${title}</b>\n${escapeHtml(line)}`);
  }
  return blocks.length ? `\n\n${blocks.join("\n")}` : "";
}

/* --------------------------------------------------
   Local store (JSONL + state)
-------------------------------------------------- */
function ensureDir(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendStore(record) {
  ensureDir(STORE_PATH);
  fs.appendFileSync(STORE_PATH, JSON.stringify(record) + "\n", "utf8");
}

function readStore(limit = 2000) {
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

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastCheckedAt: 0, processed: {} };
  }
}
function saveState(state) {
  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
function pruneProcessed(state, maxItems = 4000) {
  const entries = Object.entries(state.processed || {});
  if (entries.length <= maxItems) return;
  entries.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0)); // oldest first
  const toDelete = entries.length - maxItems;
  for (let i = 0; i < toDelete; i++) delete state.processed[entries[i][0]];
}
function markProcessed(state, id) {
  state.processed[String(id)] = Date.now();
  pruneProcessed(state);
}

function pickComparableLastWeek(current, history) {
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

function compareCurrentVsPrev(current, prev) {
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

/* --------------------------------------------------
   Message formatting (raw summary)
-------------------------------------------------- */
function formatMessage(activity, extras) {
  const distanceKm = (activity.distance ?? 0) / 1000;
  const dateTime = formatDateTimeLocal(activity.start_date_local);

  const paceBased = isPaceBased(activity.type, activity.sport_type);

  const paceAvg = paceBased && distanceKm > 0 ? secToPace(activity.moving_time / distanceKm) : null;

  const avgSpeedKmhVal =
    extras.speedAvgKmh != null
      ? extras.speedAvgKmh
      : safeNum(activity.average_speed) != null
      ? msToKmh(activity.average_speed)
      : avgSpeedKmh(activity.distance, activity.moving_time);

  const maxSpeedKmhVal =
    extras.speedMaxKmh != null
      ? extras.speedMaxKmh
      : safeNum(activity.max_speed) != null
      ? msToKmh(activity.max_speed)
      : null;

  const pwrAvg = extras.powerAvg ?? safeNum(activity.average_watts);
  const cadence = extras.cadenceAvg ?? safeNum(activity.average_cadence);

  const splits = extras.splits ?? [];
  const labelTitle = paceBased ? "Pace" : "Speed";

  const splitsText = splits.length
    ? splits
        .map((s) => {
          const hr = s.hrAvg ? ` (HR ${s.hrAvg}/${s.hrMax})` : "";
          const pw = s.powerAvg ? ` (P ${s.powerAvg}W)` : "";
          return `KM${s.km}: ${s.label}${hr}${pw}`;
        })
        .join("\n")
    : "n/d";

  const best =
    splits.length > 0
      ? splits.reduce((a, b) => {
          if (paceBased) return (b.secPerKm ?? Infinity) < (a.secPerKm ?? Infinity) ? b : a;
          return (b.speedKmh ?? -Infinity) > (a.speedKmh ?? -Infinity) ? b : a;
        }, splits[0])
      : null;

  const worst =
    splits.length > 0
      ? splits.reduce((a, b) => {
          if (paceBased) return (b.secPerKm ?? -Infinity) > (a.secPerKm ?? -Infinity) ? b : a;
          return (b.speedKmh ?? Infinity) < (a.speedKmh ?? Infinity) ? b : a;
        }, splits[0])
      : null;

  const insight = paceBased ? pacingInsight(splits) : null;

  const metricLine = paceBased
    ? `⚡ Pace médio: ${escapeHtml(paceAvg)}`
    : `🚴 Speed: ${escapeHtml(fmtKmh(avgSpeedKmhVal ?? NaN))} avg | ${escapeHtml(fmtKmh(maxSpeedKmhVal ?? NaN))} max`;

  const powerLine = !paceBased && pwrAvg != null ? `⚡ Power: ${Math.round(pwrAvg)} W avg` : "";
  const cadenceLine = cadence != null ? `🦵 Cadência: ${cadence}` : "";
  const extraInfo = [powerLine, cadenceLine].filter(Boolean).join(" | ");
  const extraInfoLine = extraInfo ? `ℹ️ ${escapeHtml(extraInfo)}` : "";

  return `
<b>🏁 Nova atividade no Strava</b>
🏷️ ${escapeHtml(activity.name)}
🧩 ${escapeHtml(activity.type)}
🕒 ${escapeHtml(dateTime)}

📏 ${distanceKm.toFixed(2)} km
⏱️ Moving: ${secToHMS(activity.moving_time)} | Elapsed: ${secToHMS(activity.elapsed_time)}
${metricLine}
❤️ FC: ${escapeHtml(extras.hrAvg ?? "n/d")} avg | ${escapeHtml(extras.hrMax ?? "n/d")} max
⬆️ Elevação: ${escapeHtml(Math.round(activity.total_elevation_gain ?? 0))} m
${extraInfoLine}

<b>📌 Splits (≈1km) — ${escapeHtml(labelTitle)}</b>
${escapeHtml(splitsText)}
${
  best && worst
    ? `<b>🏁 Best KM:</b> ${best.km} (${escapeHtml(best.label)})\n<b>🐢 Worst KM:</b> ${worst.km} (${escapeHtml(worst.label)})`
    : ""
}

<b>🧠 Insight</b>
${escapeHtml(insight ?? "n/d")}

${extras.zonesText ?? ""}
`.trim();
}

/* --------------------------------------------------
   IO: Strava + Telegram + Clawdbot
-------------------------------------------------- */
async function getToken() {
  const r = await axios.post("https://www.strava.com/oauth/token", null, {
    params: {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: STRAVA_REFRESH_TOKEN,
    },
    timeout: 15000,
  });
  return r.data.access_token;
}

async function sendTelegram(html) {
  const parts = chunkText(html);
  for (const p of parts) {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: p,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      { timeout: 15000 }
    );
  }
}

async function sendToClawdbotAgent(messageText, meta) {
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

  // If Clawdbot rejects unknown fields, comment out the next line.
  if (meta) body.meta = meta;

  await axios.post(url, body, {
    headers: { Authorization: `Bearer ${CLAWDBOT_HOOK_TOKEN}` },
    timeout: 15000,
  });
}

/* --------------------------------------------------
   Core pipeline: handle activity ID (webhook OR poll)
-------------------------------------------------- */
async function handleActivityId(activityId, source = "webhook") {
  const token = await getToken();

  const activity = (
    await axios.get(`https://www.strava.com/api/v3/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    })
  ).data;

  const streams = (
    await axios.get(`https://www.strava.com/api/v3/activities/${activityId}/streams`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        keys: "time,distance,heartrate,watts,cadence,velocity_smooth,temp,altitude",
        key_by_type: true,
      },
      timeout: 15000,
    })
  ).data;

  const paceBased = isPaceBased(activity.type, activity.sport_type);
  const splitMode = paceBased ? "pace" : "speed";
  const splits = computeSplits1km(streams, splitMode);

  const hrStats = statsFromStream(streams.heartrate?.data);
  const hrAvg = hrStats.avg != null ? Math.round(hrStats.avg) : null;
  const hrMax = hrStats.max != null ? Math.round(hrStats.max) : null;

  const pwrStats = statsFromStream(streams.watts?.data);
  const powerAvg = pwrStats.avg != null ? Math.round(pwrStats.avg) : safeNum(activity.average_watts);
  const powerMax = pwrStats.max != null ? Math.round(pwrStats.max) : null;

  const speedStats = statsFromStream(streams.velocity_smooth?.data);
  const speedAvgKmh = speedStats.avg != null ? msToKmh(speedStats.avg) : null;
  const speedMaxKmh = speedStats.max != null ? msToKmh(speedStats.max) : null;

  const cadStats = statsFromStream(streams.cadence?.data);
  const cadenceAvg = cadStats.avg != null ? Math.round(cadStats.avg) : safeNum(activity.average_cadence);

  let zonesText = "";
  try {
    const z = await axios.get(`https://www.strava.com/api/v3/activities/${activityId}/zones`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    zonesText = formatZones(z.data);
  } catch {}

  const record = {
    stored_at: new Date().toISOString(),
    source,
    activity: {
      id: activity.id,
      name: activity.name,
      type: activity.type,
      sport_type: activity.sport_type ?? null,
      start_date: activity.start_date ?? null,
      start_date_local: activity.start_date_local ?? null,
      timezone: activity.timezone ?? null,

      distance_m: activity.distance ?? null,
      moving_time_s: activity.moving_time ?? null,
      elapsed_time_s: activity.elapsed_time ?? null,
      total_elevation_gain_m: activity.total_elevation_gain ?? null,

      average_speed_ms: activity.average_speed ?? null,
      max_speed_ms: activity.max_speed ?? null,
      average_heartrate: activity.average_heartrate ?? null,
      average_cadence: activity.average_cadence ?? null,
      average_watts: activity.average_watts ?? null,
      kilojoules: activity.kilojoules ?? null,
      device_watts: activity.device_watts ?? null,
    },
    derived: {
      mode: paceBased ? "pace" : "speed",
      hr_avg_stream: hrAvg,
      hr_max_stream: hrMax,
      power_avg: powerAvg,
      power_max: powerMax,
      speed_avg_kmh: speedAvgKmh ?? avgSpeedKmh(activity.distance, activity.moving_time),
      speed_max_kmh: speedMaxKmh ?? (safeNum(activity.max_speed) != null ? msToKmh(activity.max_speed) : null),
      avg_pace_sec_per_km: paceBased ? avgPaceSecPerKm(activity.distance, activity.moving_time) : null,
      splits_1km: splits,
    },
    zones: { text: htmlToPlainText(zonesText) },
  };

  // Persist record (idempotency handled in state, not here)
  appendStore(record);

  // Compare vs last week
  const history = readStore(2500);
  const prev = pickComparableLastWeek(record, history);
  const comparison = compareCurrentVsPrev(record, prev);

  // Format summary (raw)
  const html = formatMessage(activity, {
    splits,
    hrAvg: hrAvg ?? "n/d",
    hrMax: hrMax ?? "n/d",
    zonesText,
    speedAvgKmh,
    speedMaxKmh,
    powerAvg,
    cadenceAvg,
  });

  if (String(SEND_RAW_TELEGRAM).toLowerCase() === "true") {
    await sendTelegram(html);
  }

  // Send to Clawdbot
  const plain = htmlToPlainText(html);

  const dataPayload = {
    current: record,
    last_week_comparable: prev,
    deltas_vs_last_week: comparison,
  };

  const prompt = [
    "New Strava activity received.",
    "",
    plain,
    "",
    "DATA (json):",
    "```json",
    JSON.stringify(dataPayload, null, 2),
    "```",
    "",
    "Task:",
    "- Compare this activity vs last week (use the comparable activity in DATA when present).",
    "- If this is a ride, explicitly compare speed + power + HR (efficiency).",
    "- If this is a run, compare pace + HR and mention pacing pattern from splits.",
    "- Give 1–2 concrete coaching takeaways.",
    "- Suggest the next workout based on the trend.",
    "",
    "If there is no comparable activity, say so and give a standalone coaching summary + next workout.",
  ].join("\n");

  await sendToClawdbotAgent(prompt, dataPayload);
}

/* --------------------------------------------------
   Polling fallback (catch up after sleep)
-------------------------------------------------- */
async function pollNewActivities() {
  const state = loadState();
  const now = Date.now();

  const lookbackMs = Number(POLL_LOOKBACK_HOURS) * 3600 * 1000;
  // margin: 5 min overlap to avoid edge misses
  const afterMs = state.lastCheckedAt ? state.lastCheckedAt - 5 * 60 * 1000 : now - lookbackMs;
  const afterUnix = Math.floor(afterMs / 1000);

  const token = await getToken();

  const pageLimit = Math.max(1, Number(POLL_PAGE_LIMIT || "4"));
  let page = 1;
  let fetchedAny = false;

  while (page <= pageLimit) {
    const list = (
      await axios.get("https://www.strava.com/api/v3/athlete/activities", {
        headers: { Authorization: `Bearer ${token}` },
        params: { after: afterUnix, per_page: 50, page },
        timeout: 15000,
      })
    ).data;

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

    // if fewer than 50, done
    if (list.length < 50) break;
    page += 1;
  }

  state.lastCheckedAt = now;
  saveState(state);

  if (!fetchedAny) {
    // still update lastCheckedAt so we don't keep huge lookback loops
    // already done above
  }
}

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

  // Idempotency using state (same as polling)
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

if (String(POLL_ENABLED).toLowerCase() === "true") {
  const intervalSec = Math.max(60, Number(POLL_INTERVAL_SEC || "600"));
  console.log(`🕵️ Polling enabled: every ${intervalSec}s`);

  // run once at boot (catch up)
  pollNewActivities().catch((e) => console.error("poll boot error:", e?.response?.data || e.message));

  // then keep running
  setInterval(() => {
    pollNewActivities().catch((e) => console.error("poll interval error:", e?.response?.data || e.message));
  }, intervalSec * 1000);
}
