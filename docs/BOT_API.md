# WVSP Bot API contract

The website talks to the separate WVSP bot over HTTPS using `BOT_API_URL` and a shared `BOT_API_SECRET`. All endpoints below are rooted at the configured base URL and require:

```http
Authorization: Bearer <BOT_API_SECRET>
```

Compare the secret in constant time, use TLS, reject oversized bodies, and never expose the shared secret in browser code. A 2xx response indicates success; non-2xx responses are treated as unavailable by the website. JSON responses use `Content-Type: application/json`.

## Required endpoints

### `GET /internal/wvsp/stats`

```json
{ "staffOnDuty": 3 }
```
Return the current number of staff with an active shift. `staffOnDuty` must be a non-negative number.

### `GET /internal/wvsp/users/:discordId/roblox`

Return the account linked by the bot's existing link database. Example:

```json
{ "linked": true, "account": { "robloxId": "123456789", "username": "ExamplePlayer", "displayName": "Example Player" } }
```
For an unlinked Discord account, return `{ "linked": false }` (or `{ "account": null }`). The route must only return the requested Discord user's link.

### `GET /internal/wvsp/players/:robloxId/stats`

Return the linked Roblox player's playtime and lifetime counters:

```json
{ "playtime": 1200, "kills": 12, "deaths": 4, "teamPlaytime": [{ "team": "Police", "seconds": 900 }] }
```
Playtime and team durations are seconds. Missing values may be null; do not fabricate statistics.

### `GET /internal/wvsp/users/:discordId/transcripts`

Return only ticket transcripts belonging to the requested Discord user:

```json
{ "transcripts": [{ "id": "ticket-123", "title": "Support ticket", "createdAt": "2026-01-01T00:00:00Z", "url": "https://..." }] }
```
Apply the same ownership restriction in the bot, independent of the website's route.

### `GET /internal/wvsp/transcripts` (staff)

Return all ticket transcripts for staff-panel use. The bot must additionally enforce staff authorization (e.g. accept a trusted staff identity or expose this only to a separately authenticated staff integration). Do not rely on obscurity.

### `POST /internal/wvsp/notify`

Website submits a notification for delivery to the configured WVSP review/log channel. Example body:

```json
{
  "eventType": "application | appeal | punishment | staff-request",
  "title": "New WVSP Staff Application",
  "referenceId": "APP-0001",
  "userDiscordId": "123456789012345678",
  "fields": { "department": "...", "reason": "..." }
}
```

Return `2xx` only after the bot has accepted or queued the Discord embed, for example `{ "ok": true, "messageId": "..." }`. Sanitize/embed-limit fields and avoid sending secrets or unnecessary personal data. Supported event types currently used by the website: `application`, `appeal`, `punishment`, and `staff-request`.

## Website behavior when disconnected

The public statistics and profile endpoints report `Unavailable` or `Not configured` if the integration is missing or fails. Form records remain in the website's Prisma database even when Discord notification delivery is unavailable; the response reports the notification outcome so staff can process stored submissions after recovery.
