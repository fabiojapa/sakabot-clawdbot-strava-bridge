# Sakabot Clawdbot Strava Bridge – Project Context

## Overview

**Sakabot Clawdbot Strava Bridge** is a Node.js (ESM) backend service that bridges Strava activities with AI-powered coaching via Telegram.

- **Platform**: macOS (local service)
- **Port**: 3009
- **Exposure**: Cloudflare Tunnel (internet-facing)
- **Integrations**: Strava API (OAuth), Telegram Bot API, Clawdbot (local AI agent)
- **Persistence**: File-based (JSONL store + JSON state file; no database yet)

## Purpose

When an athlete completes a Strava activity:

1. **Receive** the activity via webhook (or polling fallback when Mac sleeps)
2. **Enrich** with full details: streams (time, distance, HR, power, cadence, speed, altitude)
3. **Analyze**:
   - Compute 1 km splits (pace for runs / speed for rides)
   - Extract HR avg/max, power avg/max, speed stats from streams
   - Infer pacing pattern (negative split / fade / stable)
   - Compare against a comparable activity from last week (same type, ±20% distance, 7–14 days prior)
4. **Coach**: Format a summary, send to Clawdbot (local AI), get back coaching insights
5. **Deliver**: Reply sent to Telegram

The system is **intentionally local-first, lightweight, and hackable**. It prioritizes shipping fast over over-engineering, but is designed to scale gradually.

---

## Architecture

### Core Components

#### 1. **Strava API Client** (lines ~600–620)
- `getToken()`: Refreshes OAuth access token using refresh token flow
- Fetches activity details, streams, zones

#### 2. **Local Storage Layer** (lines ~220–290)
- **JSONL Store**: Append-only activity records (idempotency, history)
- **State File**: JSON, tracks `lastCheckedAt` (polling) and `processed` set (webhook dedup)
- `appendStore()`, `readStore()`, `loadState()`, `saveState()`
- Automatic pruning: keeps last 4000 processed IDs to prevent unbounded growth

#### 3. **Activity Analysis Pipeline** (lines ~290–450)
- **Stream Processing**: Extract HR, power, cadence, speed stats from raw Strava streams
- **Splits Calculation**: Adaptive 1 km splits with per-km pace/speed, HR, power
- **Pacing Insight**: Detects negative split, fade, or stable pacing (runs only)
- **Comparison Logic**: Finds comparable activity from last week, computes deltas

#### 4. **Message Formatting** (lines ~450–550)
- HTML-formatted raw summary (emoji-rich, structured)
- Splits breakdown, best/worst KM, pacing insight, zone distribution
- Converts HTML → plaintext for Clawdbot input

#### 5. **I/O Integrations** (lines ~600–650)
- `sendTelegram()`: Chunks large messages (Telegram 3500 char limit)
- `sendToClawdbotAgent()`: Posts coaching prompt + metadata to Clawdbot gateway

#### 6. **Core Pipeline** (lines ~650–750)
- `handleActivityId()`: Single entry point for both webhook & polling
- Fetches activity + streams, computes analysis, persists record
- Triggers Clawdbot coaching request

#### 7. **Polling Fallback** (lines ~750–810)
- `pollNewActivities()`: Runs on interval (default 10 min)
- Catches up after Mac sleep using `lastCheckedAt` timestamp
- Pages through athlete's activity list, deduplicates with `processed` set

#### 8. **Express Routes** (lines ~810–850)
- `GET /health`: Simple health check
- `GET /webhook`: Strava webhook subscription verification (hub challenge)
- `POST /webhook`: Receives Strava webhook events, triggers `handleActivityId()`

---

## Data Model

### Activity Record (JSONL)
Each record appended to `activity-store.jsonl` has this shape:

```json
{
  "stored_at": "2026-01-27T10:30:00.000Z",
  "source": "webhook|poll",
  "activity": {
    "id": 12345,
    "name": "Morning run",
    "type": "Run",
    "sport_type": "trail_run",
    "start_date": "2026-01-27T08:00:00Z",
    "start_date_local": "2026-01-27T10:00:00",
    "timezone": "America/New_York",
    "distance_m": 10200,
    "moving_time_s": 3600,
    "elapsed_time_s": 3900,
    "total_elevation_gain_m": 150,
    "average_speed_ms": 2.83,
    "max_speed_ms": 4.5,
    "average_heartrate": 155,
    "average_cadence": 165,
    "average_watts": null,
    "kilojoules": null,
    "device_watts": false
  },
  "derived": {
    "mode": "pace",
    "hr_avg_stream": 155,
    "hr_max_stream": 175,
    "power_avg": null,
    "power_max": null,
    "speed_avg_kmh": 10.2,
    "speed_max_kmh": 16.2,
    "avg_pace_sec_per_km": 353.0,
    "splits_1km": [
      {
        "km": 1,
        "mode": "pace",
        "meters": 1000,
        "seconds": 348,
        "secPerKm": 348,
        "speedKmh": 10.3,
        "label": "5:48/km",
        "hrAvg": 152,
        "hrMax": 165,
        "powerAvg": null
      }
      // ... more splits ...
    ]
  },
  "zones": {
    "text": "... zone distribution text ..."
  }
}
```

### State File (JSON)
Tracks idempotency and polling progress:

```json
{
  "lastCheckedAt": 1643275800000,
  "processed": {
    "12345": 1643275000000,
    "12344": 1643272000000
    // ... up to 4000 most recent IDs ...
  }
}
```

---

## Environment Variables

### Required
- `STRAVA_CLIENT_ID`: OAuth client ID
- `STRAVA_CLIENT_SECRET`: OAuth client secret
- `STRAVA_VERIFY_TOKEN`: Webhook verification token (you set on Strava app)
- `STRAVA_REFRESH_TOKEN`: Your personal refresh token (obtained via initial OAuth flow)
- `TELEGRAM_BOT_TOKEN`: Telegram bot API token
- `TELEGRAM_CHAT_ID`: Your Telegram chat ID (where messages are sent)
- `CLAWDBOT_HOOK_TOKEN`: Bearer token for Clawdbot gateway authorization

### Optional
- `PORT=3009`
- `CLAWDBOT_GATEWAY_URL=http://127.0.0.1:18789` (local Clawdbot agent)
- `SEND_RAW_TELEGRAM=false` (also send raw summary directly before coaching)
- `STORE_PATH=./activity-store.jsonl`
- `STATE_PATH=./state.json`
- `POLL_ENABLED=true`
- `POLL_INTERVAL_SEC=600` (10 minutes)
- `POLL_LOOKBACK_HOURS=24` (initial/safety net lookback)
- `POLL_PAGE_LIMIT=4` (max pages × 50 activities per page)

---

## Data Flow

### Webhook Path (Real-time)
```
Strava Activity Created
  ↓
POST /webhook (Strava event)
  ↓
markProcessed() [idempotency]
  ↓
handleActivityId()
  ├─ getToken()
  ├─ Fetch activity details
  ├─ Fetch streams + zones
  ├─ Compute splits, HR/power/speed stats, pacing insight
  ├─ appendStore() [persist]
  ├─ pickComparableLastWeek() [readStore(2500)]
  ├─ compareCurrentVsPrev()
  ├─ formatMessage() → HTML
  ├─ sendToClawdbotAgent()
  │   └─ Clawdbot replies to Telegram
  └─ Done
```

### Polling Path (Fallback after sleep)
```
Timer fires (every POLL_INTERVAL_SEC)
  ↓
pollNewActivities()
  ├─ Load state.lastCheckedAt
  ├─ getToken()
  ├─ Paginate /athlete/activities (after=lastCheckedAt - 5m margin)
  ├─ For each activity:
  │   ├─ Check state.processed[id] (dedup)
  │   └─ handleActivityId() [same as webhook]
  └─ Save state.lastCheckedAt = now
```

### Comparison Logic
```
Current Activity (stored_at T)
  ↓
pickComparableLastWeek()
  ├─ Filter: same activity.type
  ├─ Filter: distance ±20% of current
  ├─ Filter: start_date within [T-14d, T-7d]
  └─ Return closest match (by date)
  ↓
compareCurrentVsPrev()
  ├─ Compute deltas: distance, time, elevation, pace/speed, HR, power
  └─ Return structured comparison object
```

---

## Key Utility Functions

### Formatting & Parsing
- `secToHMS()`: Seconds → "h:mm:ss" format
- `secToPace()`: Seconds/km → "m:ss/km" format
- `msToKmh()`: m/s → km/h conversion
- `fmtKmh()`: Format speed with units
- `escapeHtml()`, `htmlToPlainText()`: HTML ↔ plaintext
- `formatDateTimeLocal()`: ISO → "yyyy-mm-dd hh:mm" local time

### Metrics Computation
- `isPaceBased()`: Detect if activity is run/walk/hike (vs bike/ride)
- `avgPaceSecPerKm()`: Calculate average pace from distance + time
- `avgSpeedKmh()`: Calculate average speed in km/h
- `statsFromStream()`: Extract avg/max from Strava stream arrays
- `computeSplits1km()`: Generate per-km splits with HR/power/speed
- `pacingInsight()`: Detect negative split / fade / stable pacing
- `pctDiff()`: Calculate percentage difference between two values

### Storage Utilities
- `ensureDir()`: Create directories recursively
- `appendStore()`: Append JSONL record
- `readStore()`: Read last N records from JSONL
- `loadState()`, `saveState()`: Manage JSON state file
- `markProcessed()`, `pruneProcessed()`: Idempotency tracking

---

## Workflows

### Adding a New Activity Type
1. Update `isPaceBased()` to recognize new type
2. Adjust split computation mode (pace vs speed)
3. Coaching prompt will adapt based on `mode` in `derived` object

### Adding a New Stream Metric
1. Include in Strava API request (line ~670, `keys` parameter)
2. Process in `handleActivityId()` using `statsFromStream()`
3. Include in record → JSONL persistence
4. Reference in `formatMessage()` for display
5. Optionally add to coaching prompt

### Supporting Multi-Athlete
1. Namespace `state.processed` by athlete ID
2. Separate JSONL stores per athlete (or athlete prefix in records)
3. Track athlete context in `sendToClawdbotAgent()` via `sessionKey`
4. Add athlete selection logic to polling/webhook routes

---

## Known Limitations & TODOs

### Current Gaps
- ❌ **No database**: JSONL + state.json is fine for single athlete, will need SQLite/Postgres for scale
- ❌ **No rate limit handling**: Can hit Strava API limits (600 req/15min). Needs backoff + queue
- ❌ **No error recovery**: If Clawdbot/Telegram fails, activity is lost from retry queue
- ❌ **Single athlete only**: No multi-user support yet
- ❌ **No testing framework**: No unit/integration tests
- ❌ **No observability**: Minimal logging, no metrics/tracing
- ❌ **No zone filtering**: Fetches zones but doesn't analyze them deeply
- ❌ **Hardcoded zone names in Portuguese**: "❤️ Zonas FC", "⚡ Zonas Potência"

### Resilience Gaps
- Webhook acknowledgment is synchronous; long operations block response
- No dead-letter queue for failed Clawdbot/Telegram sends
- Polling state is only updated on success (partial failures may cause re-runs)
- No circuit breaker for external API calls

### Scalability Concerns
- JSONL readStore(2500) loads entire tail into memory for every new activity
- State file pruneProcessed() truncates by count, not by age (stale entries kept indefinitely)
- No pagination for JSONL reads

---

## Files

```
.
├── index.js                    # Main application (840 lines)
├── package.json                # ESM dependencies (express, axios, dotenv)
├── .env                        # Secrets (required, not in repo)
├── activity-store.jsonl        # Append-only activity records
├── state.json                  # Polling state + idempotency tracking
└── PROJECT_CONTEXT.md          # This file
```

---

## Running

### Setup
```bash
npm install
cp .env.example .env            # Fill in Strava + Telegram + Clawdbot tokens
```

### Start
```bash
PORT=3009 npm start
# or
node index.js
```

The service will:
- Listen on port 3009 for webhooks
- Expose `/health` and `/webhook` routes
- Start polling loop if `POLL_ENABLED=true`
- Log to stdout

### Webhook Registration (Strava App)
```
POST https://www.strava.com/api/v3/push_subscriptions
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "callback_url": "https://your-cloudflare-tunnel.com/webhook",
  "verify_token": "YOUR_VERIFY_TOKEN"
}
```

---

## Design Principles

1. **Local-first**: All processing happens on the Mac; minimal external dependencies
2. **Idempotent**: Same activity ID is never processed twice (webhook + polling reconciliation)
3. **Async-friendly**: Respects Mac sleep/wake without requiring supervision
4. **Pragmatic**: File-based persistence is fine for 1.0; DB abstraction ready for future
5. **Hackable**: Monolithic but well-commented; easy to modify or extend
6. **Resilient**: Polling fallback ensures no activities are missed despite webhook downtime

---

## Next Phases (Suggested)

### Phase 2: Architecture
- [ ] Modularize into service classes (StravaClient, StorageService, Formatter, Coach)
- [ ] Abstract storage layer (enable SQLite/Postgres swap-in)
- [ ] Structured logging (pino or bunyan)

### Phase 3: Reliability
- [ ] Implement rate limit awareness (track Strava rate headers, backoff)
- [ ] Add retry queue for failed Clawdbot sends
- [ ] Circuit breaker for external APIs

### Phase 4: Scale
- [ ] Multi-athlete support (namespaced state, athlete routing)
- [ ] Database backend (SQLite for local, Postgres for cloud)
- [ ] Webhook delivery reliability (signed events, digest validation)

### Phase 5: Intelligence
- [ ] Deeper zone analysis (time-in-zone trends, efficiency metrics)
- [ ] Fatigue tracking across activities (RPE, HRV, recovery)
- [ ] Predictive suggestions (based on historical patterns)

---

## For AI Context

When working on this project:
- **Assume Node.js 18+, ESM modules**: No CommonJS, no `require()`
- **Know the athlete is single**: No user context switching
- **Understand idempotency is critical**: Same Strava ID = always deduplicated
- **File I/O is synchronous**: JSONL reads/writes block, but are fast for local store
- **Clawdbot is external**: Treats responses as formatted coaching text, no structured replies yet
- **Telegram is fire-and-forget**: No ack/retry loop; failures are logged but not queued
- **Strava streams are optional**: Some activities may lack HR, power, or cadence data
- **Comparison may not exist**: Not all activities have a comparable predecessor; handle gracefully

---

## Questions for Evolution

- Should we add SQLite now or stay JSONL for longer?
- Do we want Clawdbot to see coaching history (multi-turn context)?
- Should multi-athlete support be built in from the start, or added later?
- Do we need webhook delivery guarantees (idempotent storage + acks)?
- Should rate limit awareness be built-in or reactive?
