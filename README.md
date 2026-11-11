# WVSP Website

West Virginia State Roleplay community website and TypeScript/Express API.

## Requirements
- Node.js 20 or newer
- npm
- A Discord application and bot, when enabling Discord sign-in/member counts
- ER:LC server API key, when enabling live player and queue counts

## Local setup
1. Clone the repository and copy `.env.example` to `.env` in the repository root.
2. Fill in the credentials described below. Keep `.env` private; never add secrets to frontend variables.
3. Install dependencies: `npm install`.
4. Generate the Prisma client: `npm run db:generate`.
5. Create/update the local SQLite schema: `npm run db:migrate` (Prisma may ask for a migration name on first run; alternatively run `npm run db:push --workspace server` after adding that script, or `cd server && npx prisma db push`).
6. Start the frontend and API together: `npm run dev`.
7. Open `http://localhost:5173`. The Vite development server proxies `/api` and `/auth` to Express on port 3001.
8. For production: `npm run build`, then set `NODE_ENV=production` and run `npm start`. Express serves `web/dist` and falls back to the SPA entry for client routes.

Set `DISCORD_REDIRECT_URI` to `http://localhost:3001/auth/discord/callback` in the Discord developer portal for local development. Set `SITE_URL=http://localhost:5173`. For a deployed single-origin site use the public origin for `SITE_URL`; configure the matching OAuth redirect URL. Use a long random `SESSION_SECRET` in production and HTTPS so session cookies are secure.

## Data connections and unavailable states
- `/api/stats` is cached for 20 seconds. Players and queue are read from the ER:LC v1 API using `ERLC_SERVER_KEY`; Discord member count uses the bot token and guild ID. Each unavailable or failing source responds with `{ "value": null, "status": "Unavailable" }` rather than invented counts.
- Staff on duty is obtained from the separate WVSP bot through the internal authenticated API. Configure `BOT_API_URL` and `BOT_API_SECRET`. The website makes `GET {BOT_API_URL}/internal/wvsp/stats` with `Authorization: Bearer <BOT_API_SECRET>`. The bot endpoint must return JSON `{ "staffOnDuty": <number> }`. Protect that bot endpoint and compare the secret in constant time. Until connected, the UI/API reports Unavailable.
- `hero.png` should be placed at `web/public/hero.png`; the frontend uses that exact asset without cropping. If the image was not included in the repository upload, copy it there before running the site.
- Discord sign-in requires `identify`, a successful bot-token check that the user is in the configured guild, and acceptance of Privacy and Terms v1.0. Acceptance timestamps and version numbers are stored on the User record. Sessions expire after 12 hours.

## Environment variables
See `.env.example`. `VITE_` variables are public and are only for links; never place tokens/secrets in them. Unconfigured API integrations are explicitly shown as unavailable. `ROBLOX_GROUP_URL` and the quick-join/Discord URLs are public links. `ERLC_SERVER_KEY`, Discord credentials, bot API secret, and session secret must remain server-side.

## Database
The default database is SQLite at `server/prisma/dev.db`. To use Postgres, change the Prisma datasource provider to `postgresql`, set `DATABASE_URL` to a Postgres connection string, then run Prisma generate/migrations. Back up the DB and use a migration workflow when deploying schema changes.

## Notes
The site is a community-operated WVSP project and is not affiliated with Roblox, Discord, or Police Roleplay Community (PRC). Privacy/Terms acceptance is required after Discord login and must be renewed if the legal version changes.
