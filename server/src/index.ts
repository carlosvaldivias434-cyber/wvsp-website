import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma, PrismaSessionStore } from './db.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const production = process.env.NODE_ENV === 'production';
const siteUrl = process.env.SITE_URL || 'http://localhost:5173';
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: production ? undefined : false }));
app.use(cors({ origin: siteUrl, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(session({ name: 'wvsp.sid', secret: process.env.SESSION_SECRET || 'development-only-change-me', store: new PrismaSessionStore(), resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 } }));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

declare module 'express-session' { interface SessionData { oauthState?: string; userId?: string; csrf?: string; returnTo?: string } }
const configured = (...names: string[]) => names.every(name => Boolean(process.env[name]));
const safeReturn = (value: string | undefined) => value === '/staff' || value === '/stats' ? value : '/';
const loginRequired: express.RequestHandler = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Sign in required' });

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
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID!, client_secret: process.env.DISCORD_CLIENT_SECRET!, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_REDIRECT_URI! }) });
    if (!tokenResponse.ok) throw new Error('OAuth token exchange failed');
    const token = await tokenResponse.json() as { access_token: string };
    const identityResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!identityResponse.ok) throw new Error('Discord identity unavailable');
    const identity = await identityResponse.json() as { id: string; username: string; global_name?: string; avatar?: string };
    const memberResponse = await fetch(`https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${identity.id}`, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
    if (memberResponse.status === 404) return res.status(403).send('Join the WVSP Discord server before signing in.');
    if (!memberResponse.ok) throw new Error('Guild membership could not be verified');
    const member = await memberResponse.json() as { roles: string[] };
    const user = await prisma.user.upsert({ where: { discordId: identity.id }, create: { discordId: identity.id, username: identity.username, globalName: identity.global_name, avatar: identity.avatar, roles: member.roles }, update: { username: identity.username, globalName: identity.global_name, avatar: identity.avatar, roles: member.roles } });
    req.session.regenerate(err => {
      if (err) return res.status(500).send('Could not establish a secure session.');
      req.session.userId = user.id;
      req.session.csrf = randomBytes(24).toString('hex');
      req.session.save(saveErr => saveErr ? res.status(500).send('Could not save your session.') : res.redirect(`${siteUrl}${safeReturn(req.session.returnTo)}`));
    });
  } catch (error) { console.error('Discord login failed:', error); res.status(502).send('Discord sign-in failed. Please try again later.'); }
});
app.post('/auth/logout', (req, res) => {
  if (!req.session.userId) return res.status(204).end();
  if (req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'Invalid CSRF token' });
  req.session.destroy(() => { res.clearCookie('wvsp.sid'); res.status(204).end(); });
});
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { discordId: true, username: true, globalName: true, avatar: true, roles: true, privacyVersion: true, termsVersion: true } });
  if (!user) return res.json({ user: null });
  res.json({ user: { ...user, csrfToken: req.session.csrf, avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128` : null } });
});
app.get('/api/stats', (_req, res) => res.json({ players: { value: null, status: 'Unavailable' }, queue: { value: null, status: 'Unavailable' }, discordMembers: { value: null, status: 'Unavailable' }, staffOnDuty: { value: null, status: 'Unavailable' } }));
app.get('/api/csrf', loginRequired, (req, res) => { req.session.csrf ||= randomBytes(24).toString('hex'); res.json({ csrfToken: req.session.csrf }); });

if (process.env.NODE_ENV === 'production') app.use(express.static(new URL('../../web/dist', import.meta.url).pathname));
app.listen(port, () => console.log(`WVSP API listening on ${port}`));
