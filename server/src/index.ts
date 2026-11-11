import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { prisma, PrismaSessionStore } from './db.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const production = process.env.NODE_ENV === 'production';
const siteUrl = process.env.SITE_URL || 'http://localhost:5173';
const PRIVACY_VERSION = '1.0';
const TERMS_VERSION = '1.0';
const cacheMs = 20_000;
type Stat = { value: number | null; status: 'Available' | 'Unavailable' };
let statsCache: { at: number; data: Record<string, Stat> } | undefined;

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: production ? undefined : false }));
app.use(cors({ origin: siteUrl, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(session({ name: 'wvsp.sid', secret: process.env.SESSION_SECRET || 'development-only-change-me', store: new PrismaSessionStore(), resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 } }));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

declare module 'express-session' { interface SessionData { oauthState?: string; userId?: string; csrf?: string; returnTo?: string } }
const configured = (...names: string[]) => names.every(name => Boolean(process.env[name]));
const safeReturn = (value: string | undefined) => value === '/staff' || value === '/stats' ? value : '/';
const loginRequired: express.RequestHandler = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Sign in required' });
const currentLegalAccepted = (user: { privacyVersion: string | null; termsVersion: string | null }) => user.privacyVersion === PRIVACY_VERSION && user.termsVersion === TERMS_VERSION;
const csrfRequired: express.RequestHandler = (req, res, next) => req.get('x-csrf-token') === req.session.csrf ? next() : res.status(403).json({ error: 'Invalid CSRF token' });
const unavailable = (): Stat => ({ value: null, status: 'Unavailable' });
async function fetchStat(url: string, headers: Record<string, string>, parse: (data: any) => number): Promise<Stat> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return unavailable();
    const value = parse(await response.json());
    return Number.isFinite(value) && value >= 0 ? { value, status: 'Available' } : unavailable();
  } catch { return unavailable(); }
}
async function liveStats() {
  const headers = process.env.ERLC_SERVER_KEY ? { 'Server-Key': process.env.ERLC_SERVER_KEY } : {};
  const playersPromise = configured('ERLC_SERVER_KEY') ? fetchStat('https://api.policeroleplay.community/v1/server/players', headers, data => Array.isArray(data) ? data.length : Number.NaN) : Promise.resolve(unavailable());
  const queuePromise = configured('ERLC_SERVER_KEY') ? fetchStat('https://api.policeroleplay.community/v1/server/queue', headers, data => Array.isArray(data) ? data.length : Array.isArray(data?.queue) ? data.queue.length : Number.NaN) : Promise.resolve(unavailable());
  const discordPromise = configured('DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID') ? fetchStat(`https://discord.com/api/v10/guilds/${encodeURIComponent(process.env.DISCORD_GUILD_ID!) }?with_counts=true`, { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, data => Number(data.approximate_member_count)) : Promise.resolve(unavailable());
  const staffPromise: Promise<Stat> = configured('BOT_API_URL', 'BOT_API_SECRET') ? fetchStat(`${process.env.BOT_API_URL!.replace(/\/$/, '')}/internal/wvsp/stats`, { Authorization: `Bearer ${process.env.BOT_API_SECRET}` }, data => Number(data.staffOnDuty)) : Promise.resolve(unavailable());
  const [players, queue, discordMembers, staffOnDuty] = await Promise.all([playersPromise, queuePromise, discordPromise, staffPromise]);
  return { players, queue, discordMembers, staffOnDuty };
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/auth/discord', (req, res) => {
  if (!configured('DISCORD_CLIENT_ID', 'DISCORD_REDIRECT_URI')) return res.status(503).send('Discord sign-in is not configured.');
  const state = randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.returnTo = safeReturn(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
  const params = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID!, redirect_uri: process.env.DISCORD_REDIRECT_URI!, response_type: 'code', scope: 'identify', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
app.get('/auth/discord/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) return res.status(400).send('Invalid OAuth state. Please try signing in again.');
  if (!configured('DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID')) return res.status(503).send('Discord sign-in is not fully configured.');
  const returnTo = safeReturn(req.session.returnTo);
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID!, client_secret: process.env.DISCORD_CLIENT_SECRET!, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_REDIRECT_URI! }) });
    if (!tokenResponse.ok) throw new Error('OAuth token exchange failed');
    const token = await tokenResponse.json() as { access_token: string };
    const identityResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!identityResponse.ok) throw new Error('Discord identity unavailable');
    const identity = await identityResponse.json() as { id: string; username: string; global_name?: string; avatar?: string };
    const memberResponse = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${identity.id}`, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
    if (memberResponse.status === 404) return res.status(403).send('Join the WVSP Discord server before signing in.');
    if (!memberResponse.ok) throw new Error('Guild membership could not be verified');
    const member = await memberResponse.json() as { roles: string[] };
    const user = await prisma.user.upsert({ where: { discordId: identity.id }, create: { discordId: identity.id, username: identity.username, globalName: identity.global_name, avatar: identity.avatar, roles: member.roles }, update: { username: identity.username, globalName: identity.global_name, avatar: identity.avatar, roles: member.roles } });
    req.session.regenerate(err => {
      if (err) return res.status(500).send('Could not establish a secure session.');
      req.session.userId = user.id;
      req.session.csrf = randomBytes(24).toString('hex');
      req.session.returnTo = returnTo;
      req.session.save(saveErr => saveErr ? res.status(500).send('Could not save your session.') : res.redirect(`${siteUrl}${currentLegalAccepted(user) ? returnTo : '/legal-consent'}`));
    });
  } catch (error) { console.error('Discord login failed:', error); res.status(502).send('Discord sign-in failed. Please try again later.'); }
});
app.post('/auth/logout', (req, res) => {
  if (!req.session.userId) return res.status(204).end();
  if (req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'Invalid CSRF token' });
  req.session.destroy(() => { res.clearCookie('wvsp.sid'); res.status(204).end(); });
});
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null, legal: { privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION } });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { discordId: true, username: true, globalName: true, avatar: true, roles: true, privacyVersion: true, termsVersion: true, privacyAcceptedAt: true, termsAcceptedAt: true } });
  if (!user) return res.json({ user: null, legal: { privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION } });
  res.json({ user: { ...user, csrfToken: req.session.csrf, avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128` : null, legalAcceptanceRequired: !currentLegalAccepted(user) }, legal: { privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION } });
});
app.get('/api/stats', async (_req, res) => {
  if (statsCache && Date.now() - statsCache.at < cacheMs) return res.json(statsCache.data);
  const data = await liveStats();
  statsCache = { at: Date.now(), data };
  res.set('Cache-Control', 'public, max-age=20').json(data);
});
app.get('/api/csrf', loginRequired, (req, res) => { req.session.csrf ||= randomBytes(24).toString('hex'); res.json({ csrfToken: req.session.csrf }); });
app.post('/api/legal/accept', loginRequired, csrfRequired, async (req, res) => {
  const input = z.object({ privacyVersion: z.literal(PRIVACY_VERSION), termsVersion: z.literal(TERMS_VERSION), accepted: z.literal(true) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Please accept the current Privacy Policy and Terms.' });
  const now = new Date();
  await prisma.user.update({ where: { id: req.session.userId! }, data: { privacyVersion: input.data.privacyVersion, termsVersion: input.data.termsVersion, privacyAcceptedAt: now, termsAcceptedAt: now } });
  res.json({ ok: true, acceptedAt: now.toISOString() });
});

if (production) {
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  app.use(express.static(webDist));
  app.get(/^\/(?!api(?:\/|$)|auth(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}
app.listen(port, () => console.log(`WVSP API listening on ${port}`));
