# WVSP Website

West Virginia State Roleplay community site and Express API.

## Local setup
- Requires Node.js 20+ and npm.
- Copy the repository-root `.env.example` to `.env`. The Express server loads this file explicitly from the repository root; Vite loads it from the root via `envDir: '..'`.
- Install dependencies with `npm install`.
- Initialize Prisma: `npm run db:generate` then `npm run db:push`.
- Start API and web in development with `npm run dev`, then open `http://localhost:5173`.
- Build with `npm run build`; production runs with `NODE_ENV=production npm start` and serves the React app and SPA routes from Express.

For local Discord OAuth, register `http://localhost:3001/auth/discord/callback` as the redirect URL, set `SITE_URL=http://localhost:5173`, and configure the required Discord application/bot/guild values. `.env.example` lists all supported variables. Missing integrations are reported as `Not configured` or `Unavailable` and do not use sample data. For ER:LC, provide `ERLC_SERVER_KEY`. Staff duty and profile records require the separately hosted WVSP bot integration documented in [`docs/BOT_API.md`](docs/BOT_API.md).

SQLite is the default (`DATABASE_URL=file:./dev.db`). Keep `.env` and production secrets out of version control. `VITE_` variables are public URLs only. Use HTTPS and a strong `SESSION_SECRET` in deployment.

Privacy and Terms are versioned at v1.0 and acceptance is saved with each user's version and timestamp. Users must be a member of the configured Discord guild, sign in with Discord, and accept current policies before submitting forms or using profile endpoints. Sessions last 12 hours.

WVSP is a community-operated roleplay project and is not affiliated with Roblox, Discord, or Police Roleplay Community (PRC).
