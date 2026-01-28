/**
 * Activity handler - core pipeline
 */

import {
  getActivity,
  getActivityStreams,
  getActivityZones,
  getToken,
} from "../integrations/strava.js";
import { sendTelegram } from "../integrations/telegram.js";
import { sendToClawdbotAgent } from "../integrations/clawdbot.js";
import {
  appendStore,
  readStore,
  pickComparableLastWeek,
  compareCurrentVsPrev,
  markProcessed,
  saveState,
  loadState,
} from "../storage/store.js";
import { formatMessage } from "./message-formatter.js";
import {
  computeSplits1km,
  statsFromStream,
  isPaceBased,
  avgSpeedKmh,
  avgPaceSecPerKm,
  formatZones,
} from "../utils/stream-analysis.js";
import { escapeHtml, htmlToPlainText, safeNum, msToKmh } from "../utils/formatters.js";

const { SEND_RAW_TELEGRAM = "false" } = process.env;

export async function handleActivityId(activityId, source = "webhook") {
  const token = await getToken();

  const activity = await getActivity(activityId, token);
  const streams = await getActivityStreams(activityId, token);
  const zones = await getActivityZones(activityId, token);

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

  const zonesText = formatZones(zones, escapeHtml);

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

  appendStore(record);

  const history = readStore(2500);
  const prev = pickComparableLastWeek(record, history);
  const comparison = compareCurrentVsPrev(record, prev);

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
