/**
 * Stream analysis utilities
 */

import { safeNum, msToKmh, secToPace, fmtKmh } from "./formatters.js";

export function statsFromStream(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return { avg: null, max: null };
  const xs = arr.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (xs.length === 0) return { avg: null, max: null };
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const max = Math.max(...xs);
  return { avg, max };
}

export function isPaceBased(activityType, sportType) {
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

export function avgPaceSecPerKm(distance_m, moving_time_s) {
  const dKm = safeNum(distance_m) != null ? distance_m / 1000 : null;
  const t = safeNum(moving_time_s);
  if (!dKm || !t || dKm <= 0 || t <= 0) return null;
  return t / dKm;
}

export function avgSpeedKmh(distance_m, moving_time_s) {
  const d = safeNum(distance_m);
  const t = safeNum(moving_time_s);
  if (!d || !t || d <= 0 || t <= 0) return null;
  return msToKmh(d / t);
}

export function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return (a - b) / b;
}

export function computeSplits1km(streams, mode /* "pace" | "speed" */) {
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

export function pacingInsight(splits) {
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

export function formatZones(zones, escapeHtml) {
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
