# Project Architecture

## Directory Structure

```
sakabot-clawdbot-strava-bridge/
├── src/                          # Source code (modular)
│   ├── utils/                    # Utility modules
│   │   ├── formatters.js        # Text & date formatting, HTML escaping
│   │   └── stream-analysis.js   # Stream data processing, split calculations, pacing insights
│   │
│   ├── storage/                  # Data persistence
│   │   └── store.js             # JSONL storage, state management, activity comparison logic
│   │
│   ├── integrations/             # External service integrations
│   │   ├── strava.js            # Strava API client (activities, streams, zones)
│   │   ├── telegram.js          # Telegram bot integration
│   │   └── clawdbot.js          # Clawdbot AI coaching gateway
│   │
│   └── core/                     # Core business logic
│       ├── activity-handler.js  # Main pipeline: fetch → analyze → format → send
│       ├── message-formatter.js # Activity summary HTML formatting
│       └── polling.js           # Fallback polling for Mac sleep scenarios
│
├── index.js                      # Express server & webhook routes (lean entry point)
├── package.json
├── .env.example                  # Environment variables template
├── .gitignore
├── README.md                     # User-facing documentation
├── PROJECT_CONTEXT.md           # Detailed project overview
└── activity-store.jsonl         # Append-only activity records
```

## Module Responsibilities

### `src/utils/`

#### `formatters.js`
- **Purpose**: Text formatting, conversion, escaping utilities
- **Exports**: 
  - `safeNum()` — Safe numeric conversion
  - `secToHMS()`, `secToPace()`, `msToKmh()`, `fmtKmh()` — Time/distance conversions
  - `escapeHtml()`, `htmlToPlainText()` — HTML handling
  - `formatDateTimeLocal()` — Date formatting
  - `chunkText()` — Split long text (for Telegram's 3500 char limit)

#### `stream-analysis.js`
- **Purpose**: Strava stream data processing and activity insights
- **Exports**:
  - `statsFromStream()` — Extract avg/max from stream arrays
  - `isPaceBased()` — Determine if run/walk vs bike/ride
  - `avgPaceSecPerKm()`, `avgSpeedKmh()`, `pctDiff()` — Metrics calculations
  - `computeSplits1km()` — Generate 1 km splits with HR, power, pace/speed
  - `pacingInsight()` — Detect negative split, fade, or stable pacing
  - `formatZones()` — Format HR/power zones for display

### `src/storage/`

#### `store.js`
- **Purpose**: File-based persistence and state management
- **Exports**:
  - `appendStore()`, `readStore()` — JSONL activity store operations
  - `loadState()`, `saveState()` — JSON state file (last checked, processed IDs)
  - `markProcessed()`, `pruneProcessed()` — Idempotency & deduplication
  - `pickComparableLastWeek()` — Find similar past activity (same type, ±20% distance, 7-14 days prior)
  - `compareCurrentVsPrev()` — Compute deltas (pace, speed, HR, power) vs comparable activity
- **Key Design**:
  - **Idempotency**: Each activity ID is tracked in `processed` set to prevent duplicates
  - **Auto-pruning**: Keeps only last 4000 processed IDs to bound memory
  - **No database**: Simple file-based storage (JSONL + JSON state)

### `src/integrations/`

#### `strava.js`
- **Purpose**: Strava API client
- **Exports**:
  - `getToken()` — OAuth refresh token flow
  - `getActivity()` — Fetch single activity details
  - `getActivityStreams()` — Fetch raw streams (time, distance, HR, watts, etc.)
  - `getActivityZones()` — Fetch HR/power zones
  - `listActivities()` — List athlete's activities with pagination

#### `telegram.js`
- **Purpose**: Telegram bot message delivery
- **Exports**:
  - `sendTelegram()` — Send HTML message, auto-chunks for 3500 char limit

#### `clawdbot.js`
- **Purpose**: Clawdbot AI coaching integration
- **Exports**:
  - `sendToClawdbotAgent()` — POST coaching prompt to Clawdbot gateway

### `src/core/`

#### `activity-handler.js`
- **Purpose**: Main activity processing pipeline
- **Exports**:
  - `handleActivityId(activityId, source)` — Single entry point (webhook & polling)
    1. Fetch activity details + streams + zones from Strava
    2. Compute splits, HR/power stats, pacing insight
    3. Build record, persist to store
    4. Find comparable activity from last week
    5. Calculate deltas
    6. Format HTML summary
    7. Send to Clawdbot for coaching (+ optional raw Telegram if `SEND_RAW_TELEGRAM=true`)

#### `message-formatter.js`
- **Purpose**: Format activity data into rich HTML summary
- **Exports**:
  - `formatMessage()` — Generate HTML with emojis, splits, best/worst KM, pacing insight
- **Includes**: Distance, time, pace/speed, HR, power, elevation, cadence, zones

#### `polling.js`
- **Purpose**: Fallback polling (catch up when Mac sleeps)
- **Exports**:
  - `startPolling()` — Initialize polling loop
  - `pollNewActivities()` — Fetch new activities since last check, handle each via `handleActivityId()`
- **Features**:
  - Respects `POLL_ENABLED`, `POLL_INTERVAL_SEC`, `POLL_LOOKBACK_HOURS`, `POLL_PAGE_LIMIT`
  - Auto-deduplicates via state
  - Runs once at boot, then on interval

### `index.js` (Entry Point)

- **Purpose**: Express server, webhook routes, polling orchestration
- **Routes**:
  - `GET /health` — Health check
  - `GET /webhook` — Strava webhook subscription verification (hub challenge)
  - `POST /webhook` — Receive Strava activity events, trigger `handleActivityId()`
- **Lifecycle**:
  1. Load env vars
  2. Set up Express + JSON middleware
  3. Define routes
  4. Listen on `PORT`
  5. Call `startPolling()` if enabled

## Data Flow

### Webhook Path (Real-time)
```
Strava Webhook → POST /webhook 
  → loadState (check processed set)
  → handleActivityId()
    → getActivity, getStreams, getZones
    → computeSplits, extract stats
    → appendStore(record)
    → pickComparableLastWeek + compareCurrentVsPrev
    → formatMessage
    → sendTelegram (optional)
    → sendToClawdbotAgent (coaching request)
  → markProcessed, saveState
```

### Polling Path (Fallback on Mac Sleep)
```
setInterval(pollNewActivities, POLL_INTERVAL_SEC)
  → listActivities(after: lastCheckedAt)
  → for each activity: [same as webhook path above]
  → update lastCheckedAt in state
```

## Key Design Decisions

1. **Modular Structure**
   - Utilities, storage, integrations, and core logic are separate modules
   - Each module has a single responsibility
   - Easy to test, replace, or extend

2. **File-Based Storage (No Database)**
   - JSONL for append-only activity records (idempotent, easy to replay)
   - JSON state for polling cursors + processed IDs
   - Scales well for individual athlete use

3. **Idempotent Processing**
   - Webhook may deliver same event 2–3 times
   - Polling may pick up same activity twice
   - Tracked via `processed` set in state file

4. **Lean Entry Point**
   - `index.js` is minimal (~80 lines)
   - Delegates all logic to well-organized modules
   - Easy to understand flow at a glance

5. **Async/Await Throughout**
   - All I/O (Strava, Telegram, Clawdbot, file ops) is async
   - Error handling is consistent
   - No blocking operations

## Testing the Refactored Project

```bash
npm start
# Output: 
# 🕵️ Polling enabled: every 600s
# 🚀 Strava webhook listening on 3009

# In another terminal:
curl http://localhost:3009/health
# { "ok": true, "ts": "2026-01-27T15:30:00.000Z" }
```

All logic is preserved; only the organization has changed.
