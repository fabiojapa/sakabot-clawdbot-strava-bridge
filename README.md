# Sakabot Clawdbot Strava Bridge

A lightweight Node.js service that bridges Strava activities with AI-powered coaching via Telegram.

When you complete an activity on Strava, this service:
1. Fetches full activity details and stream data
2. Computes splits, metrics, and performance insights
3. Compares it against a similar activity from last week
4. Sends a coaching prompt to a local AI agent (Clawdbot)
5. Delivers coaching insights back to Telegram

**Local-first, no database required, runs on your Mac.**

---

## Features

✅ **Real-time webhook + polling fallback** — Never misses an activity, even when your Mac sleeps
✅ **Rich stream analysis** — HR, power, cadence, speed, altitude per km split
✅ **Smart comparisons** — Finds comparable activities from last week automatically
✅ **AI coaching** — Sends activity data to local Clawdbot agent for personalized insights
✅ **Telegram delivery** — Formatted summaries + coaching replies sent directly to you
✅ **Idempotent** — Handles duplicate webhooks gracefully
✅ **Minimal dependencies** — Just Express, Axios, and dotenv

---

## Requirements

- **Node.js** 18+ (ESM support)
- **Mac** (local service, exposed via Cloudflare Tunnel or similar)
- **Strava account** with API access (need OAuth credentials)
- **Telegram bot** (for message delivery)
- **Clawdbot** local agent (optional; for AI coaching; if omitted, raw summaries only)
- **Cloudflare Tunnel** (or similar) to expose webhook to the internet

---

## Installation

```bash
# Clone or cd into the project
cd sakabot-clawdbot-strava-bridge

# Install dependencies
npm install

# Copy env template
cp .env.example .env
# OR create .env manually (see Configuration below)

# Start the service
npm start
# Output: "🚀 Strava webhook listening on 3009"
```

---

## Configuration

Create a `.env` file in the project root with the following variables:

### Required
```env
# Strava OAuth
STRAVA_CLIENT_ID=your_client_id_here
STRAVA_CLIENT_SECRET=your_client_secret_here
STRAVA_VERIFY_TOKEN=your_webhook_verify_token_here
STRAVA_REFRESH_TOKEN=your_refresh_token_here

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Clawdbot AI Agent (coaching)
CLAWDBOT_HOOK_TOKEN=your_clawdbot_token_here
```

### Optional
```env
# Server
PORT=3009

# Clawdbot Gateway (default: local)
CLAWDBOT_GATEWAY_URL=http://127.0.0.1:18789

# Telegram: also send raw summary before AI coaching
SEND_RAW_TELEGRAM=false

# Storage
STORE_PATH=./activity-store.jsonl
STATE_PATH=./state.json

# Polling (fallback for Mac sleep)
POLL_ENABLED=true
POLL_INTERVAL_SEC=600            # 10 minutes
POLL_LOOKBACK_HOURS=24           # Initial lookback window
POLL_PAGE_LIMIT=4                # Max pages to fetch (50 activities/page)
```

### Getting Strava Credentials

1. **Create a Strava app**: https://www.strava.com/settings/api
   - You'll get `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`

2. **Get your refresh token**:
   ```bash
   # Use Strava OAuth flow (requires a short script or browser)
   # See: https://developers.strava.com/docs/authentication/
   ```
   - This gives you `STRAVA_REFRESH_TOKEN`

3. **Create a webhook verify token**: Any random string (e.g., `mysecrettoken123`)
   - This is `STRAVA_VERIFY_TOKEN`

### Getting Telegram Bot Token

1. **Create a bot with BotFather**:
   - Chat with `@BotFather` on Telegram
   - Create a new bot, copy the API token
   - This is `TELEGRAM_BOT_TOKEN`

2. **Get your chat ID**:
   - Send a message to your bot
   - Navigate to `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Find your user ID in the JSON response
   - This is `TELEGRAM_CHAT_ID`

### Getting Clawdbot Token

If running Clawdbot locally:
- Check your `clawdbot.json` config for `hooks.token`
- Use that value for `CLAWDBOT_HOOK_TOKEN`

If not using Clawdbot:
- Set `CLAWDBOT_HOOK_TOKEN` to any non-empty value (won't be used)
- Or omit `SEND_RAW_TELEGRAM=false` to get raw summaries directly

---

## Running

### Start the Service

```bash
npm start
```

You should see:
```
🚀 Strava webhook listening on 3009
🕵️ Polling enabled: every 600s
```

### Register Webhook with Strava

Once the service is running and exposed to the internet (via Cloudflare Tunnel, ngrok, etc.):

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d callback_url=https://your-tunnel-domain.com/webhook \
  -d verify_token=YOUR_VERIFY_TOKEN
```

Strava will now send webhook events to your service whenever you complete an activity.

### Health Check

```bash
curl http://localhost:3009/health
# {"ok":true,"ts":"2026-01-27T10:30:00.000Z"}
```

---

## How It Works

### Webhook Flow (Real-time)
```
1. You complete an activity on Strava
2. Strava POSTs to /webhook on your service
3. Service fetches full activity + streams
4. Computes splits, HR, power, speed stats
5. Compares vs similar activity from last week
6. Sends coaching prompt to Clawdbot
7. Clawdbot replies → delivered to Telegram
```

### Polling Flow (Fallback)
```
Every 10 minutes (or POLL_INTERVAL_SEC):
1. Service queries Strava for recent activities
2. Cross-references with processed set (no duplicates)
3. For each new activity: same as webhook flow
4. Updates lastCheckedAt timestamp
```

When your Mac wakes up from sleep, polling catches up automatically with a 5-minute overlap margin.

### Comparison Logic
```
Current Activity (just completed)
  ↓
Find a comparable activity from last week:
  - Same activity type (Run vs Ride)
  - Distance within ±20%
  - Started 7–14 days ago
  ↓
Compare deltas:
  - Pace/speed, duration, elevation
  - Heart rate, power, cadence
  ↓
Include in coaching prompt to Clawdbot
```

---

## Output Example

### Telegram Message (Raw Summary)
```
🏁 Nova atividade no Strava
🏷️ Morning run
🧩 Run
🕒 2026-01-27 10:00

📏 10.20 km
⏱️ Moving: 1:00:23 | Elapsed: 1:02:45
⚡ Pace médio: 5:54/km
❤️ FC: 156 avg | 174 max
⬆️ Elevação: 145 m

📌 Splits (≈1km) — Pace
KM1: 5:48/km (HR 152/165)
KM2: 5:52/km (HR 155/168)
... (more splits)
KM10: 6:02/km (HR 160/172)

🏁 Best KM: 1 (5:48/km)
🐢 Worst KM: 10 (6:02/km)

🧠 Insight
Negative split ✅

❤️ Zonas FC
Z1: 5% | Z2: 15% | Z3: 45% | Z4: 25% | Z5: 10%
```

### Telegram Message (Clawdbot Coaching)
```
Great negative split today! Your first 5 km averaged 5:50/km,
and you held a strong final push at 5:56/km despite the elevation.

Compared to last Tuesday's 10 km run:
- 0.5 sec/km faster (pace)
- Heart rate 4 bpm lower (more efficient)
- Pacing pattern much more controlled (vs slight fade last week)

Next workout: Try a tempo run at 5:45/km for 5 km to push that
threshold work. You're trending stronger.
```

---

## Data Storage

### Activity Store (`activity-store.jsonl`)
Append-only JSONL file. Each line is a complete activity record:
```json
{
  "stored_at": "2026-01-27T10:30:00.000Z",
  "source": "webhook|poll",
  "activity": { ... },
  "derived": { ... },
  "zones": { ... }
}
```

### State File (`state.json`)
Tracks polling progress and idempotency:
```json
{
  "lastCheckedAt": 1643275800000,
  "processed": {
    "12345": 1643275000000,
    "12344": 1643272000000
  }
}
```

**No external database needed.** Files grow incrementally. Processed IDs are pruned after 4000 entries.

---

## Troubleshooting

### "Missing env var: STRAVA_CLIENT_ID"
Check your `.env` file and ensure all required variables are set. See [Configuration](#configuration) above.

### Webhook not firing
1. Verify webhook is registered: `curl https://www.strava.com/api/v3/push_subscriptions -H "Authorization: Bearer YOUR_TOKEN"`
2. Ensure your tunnel (Cloudflare, ngrok) is active and pointing to `localhost:3009`
3. Check service logs for errors

### Polling is enabled but not catching activities
1. Verify `POLL_ENABLED=true` in `.env`
2. Check `POLL_INTERVAL_SEC` (should be ≥60 seconds)
3. Ensure `state.json` exists and `lastCheckedAt` is recent

### Clawdbot request fails
1. Ensure Clawdbot is running locally on the gateway URL
2. Verify `CLAWDBOT_HOOK_TOKEN` matches your Clawdbot config
3. Check service logs for HTTP error details

### Telegram message not delivered
1. Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct
2. Ensure bot has permission to send to that chat
3. Check for Telegram rate limits (may queue large batches)

### "activity-store.jsonl" growing too large
- This is normal. File grows by ~2KB per activity.
- For 1000 activities/year, expect ~2MB growth.
- Optionally implement archival (move old records to compressed files).

---

## Development

### Project Structure
```
.
├── index.js                      # Main app (840 lines, ESM)
├── package.json                  # Dependencies
├── .env                          # Secrets (not in repo)
├── activity-store.jsonl          # Activity records
├── state.json                    # Polling + idempotency state
├── PROJECT_CONTEXT.md            # For AI/developer context
└── README.md                     # This file
```

### Adding Features

See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md#workflows) for:
- Adding a new activity type
- Adding a new stream metric
- Supporting multi-athlete

### Testing

Currently no test framework. To add:
```bash
npm install --save-dev jest
# Then write tests in *.test.js
```

---

## Roadmap

### Phase 2: Architecture (Near-term)
- [ ] Modularize into services (StravaClient, Storage, Formatter)
- [ ] Abstract storage layer (enable SQLite/Postgres later)
- [ ] Structured logging (pino)

### Phase 3: Reliability (Medium-term)
- [ ] Rate limit awareness (Strava quota tracking)
- [ ] Retry queue for failed sends
- [ ] Circuit breaker for external APIs

### Phase 4: Scale (Long-term)
- [ ] Multi-athlete support
- [ ] Database backend (SQLite local, Postgres cloud)
- [ ] Webhook delivery guarantees

---

## Performance & Limits

- **Strava API**: 600 requests per 15 minutes (per athlete)
- **Telegram**: ~30 messages/second per bot
- **Local storage**: No hard limit; ~2KB per activity
- **Processing time**: ~3–5 seconds per activity (depends on stream size + Clawdbot latency)

---

## License

MIT (or your preference)

---

## Support

For questions or issues:
1. Check [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for architecture deep-dive
2. Review comments in `index.js` (heavily documented)
3. Check service logs for error details
4. Open an issue in the repo (if shared)

---

## Credits

Built as a personal training tool. Integrates:
- **Strava API** for activity data
- **Telegram Bot API** for delivery
- **Clawdbot** (local AI agent) for coaching
- **Cloudflare Tunnel** for internet exposure

Inspired by the need for lightweight, local-first coaching feedback without external AI APIs or databases.
