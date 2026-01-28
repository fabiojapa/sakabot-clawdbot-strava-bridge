/**
 * Message formatting for activity summaries
 */

import {
  escapeHtml,
  msToKmh,
  secToHMS,
  secToPace,
  fmtKmh,
  formatDateTimeLocal,
} from "../utils/formatters.js";
import { isPaceBased, avgPaceSecPerKm, avgSpeedKmh, pacingInsight } from "../utils/stream-analysis.js";
import { safeNum } from "../utils/formatters.js";

export function formatMessage(activity, extras) {
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
