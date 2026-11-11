import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
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
const submissionLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many submissions. Please try again later.' } });

declare module 'express-session' { interface SessionData { oauthState?: string; userId?: string; csrf?: string; returnTo?: string } }
const configured = (...names: string[]) => names.every(name => Boolean(process.env[name]));
const safeReturn = (value: string | undefined) => value === '/staff' || value === '/stats' ? value : '/';
const loginRequired: express.RequestHandler = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Sign in required' });
const currentLegalAccepted = (user: { privacyVersion: string | null; termsVersion: string | null }) => user.privacyVersion === PRIVACY_VERSION && user.termsVersion === TERMS_VERSION;
const acceptedUser: express.RequestHandler = async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in required' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { privacyVersion: true, termsVersion: true } });
    if (!user || !currentLegalAccepted(user)) return res.status(403).json({ error: 'Accept the current WVSP Privacy Policy and Terms first.', code: 'LEGAL_ACCEPTANCE_REQUIRED' });
    next();
  } catch { res.status(500).json({ error: 'Could not verify account status.' }); }
};
const csrfRequired: express.RequestHandler = (req, res, next) => req.get('x-csrf-token') === req.session.csrf ? next() : res.status(403).json({ error: 'Invalid CSRF token' });
const unavailable = (): Stat => ({ value: null, status: 'Unavailable' });
async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) }); return response.ok ? response.json() : null; } catch { return null; }
}
function numberStat(value: unknown): Stat { const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) && n >= 0 ? { value: n, status: 'Available' } : unavailable(); }
async function erlcStats() {
  if (!configured('ERLC_SERVER_KEY')) return { players: unavailable(), queue: unavailable(), maxPlayers: unavailable() };
  const headers = { 'Server-Key': process.env.ERLC_SERVER_KEY! };
  const [playersData, queueData, serverData] = await Promise.all([
    fetchJson('https://api.policeroleplay.community/v1/server/players', headers),
    fetchJson('https://api.policeroleplay.community/v1/server/queue', headers),
    fetchJson('https://api.policeroleplay.community/v1/server', headers),
  ]);
  const players = Array.isArray(playersData) ? { value: playersData.length, status: 'Available' as const } : unavailable();
  const queue = Array.isArray(queueData) ? { value: queueData.length, status: 'Available' as const } : Array.isArray(queueData?.queue) ? { value: queueData.queue.length, status: 'Available' as const } : unavailable();
  const maxPlayers = serverData ? numberStat(serverData.MaxPlayers ?? serverData.maxPlayers ?? serverData.max_players) : unavailable();
  return { players, queue, maxPlayers };
}
async function notifyBot(eventType: string, title: string, referenceId: string, userDiscordId: string, fields: Record<string, unknown>) {
  if (!configured('BOT_API_URL', 'BOT_API_SECRET')) return { delivered: false, reason: 'Not configured' };
  try {
    const response = await fetch(`${process.env.BOT_API_URL!.replace(/\/$/, '')}/internal/wvsp/notify`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.BOT_API_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, title, referenceId, userDiscordId, fields }), signal: AbortSignal.timeout(6000),
    });
    return { delivered: response.ok, reason: response.ok ? undefined : 'Unavailable' };
  } catch { return { delivered: false, reason: 'Unavailable' }; }
}
const text = (max: number) => z.string().trim().min(1).max(max);
const applicationSchema = z.object({ department: text(80), experience: text(3000), availability: text(1000), why: text(3000), robloxUsername: z.string().trim().max(40).optional().default('') });
const appealSchema = z.object({ discordUsername: text(100), action: text(200), reason: text(3000), evidence: z.string().trim().max(2000).optional().default('') });
const banAppealSchema = z.object({ robloxUsername: text(40), robloxId: z.string().trim().regex(/^\d{1,20}$/).optional().or(z.literal('')).default(''), reason: text(3000), evidence: z.string().trim().max(2000).optional().default('') });
const requestSchema = z.object({ message: text(1000) });
async function createIdentifier(prefix: string) {
  return prisma.$transaction(async tx => {
    const sequence = await tx.sequence.upsert({ where: { key: prefix }, create: { key: prefix, value: 1 }, update: { value: { increment: 1 } } });
    return `${prefix}-${String(sequence.value).padStart(4, '0')}`;
  });
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
  const erlc = await erlcStats();
  const [discordMembers, staffOnDuty] = await Promise.all([
    configured('DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID') ? fetchJson(`https://discord.com/api/v10/guilds/${encodeURIComponent(process.env.DISCORD_GUILD_ID!)}?with_counts=true`, { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }).then(data => data ? numberStat(data.approximate_member_count ?? data.member_count) : unavailable()) : Promise.resolve(unavailable()),
    configured('BOT_API_URL', 'BOT_API_SECRET') ? fetchJson(`${process.env.BOT_API_URL!.replace(/\/$/, '')}/internal/wvsp/stats`, { Authorization: `Bearer ${process.env.BOT_API_SECRET}` }).then(data => data ? numberStat(data.staffOnDuty) : unavailable()) : Promise.resolve(unavailable()),
  ]);
  const data = { ...erlc, discordMembers, staffOnDuty };
  statsCache = { at: Date.now(), data };
  res.set('Cache-Control', 'public, max-age=20').json(data);
});
app.get('/api/csrf', loginRequired, (req, res) => { req.session.csrf ||= randomBytes(24).toString('hex'); res.json({ csrfToken: req.session.csrf }); });
app.post('/api/legal/accept', loginRequired, csrfRequired, async (req, res) => {
  const input = z.object({ privacyVersion: z.literal(PRIVACY_VERSION), termsVersion: z.literal(TERMS_VERSION), accepted: z.literal(true) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Please accept the current WVSP Privacy Policy and Terms.' });
  const now = new Date();
  await prisma.user.update({ where: { id: req.session.userId! }, data: { privacyVersion: input.data.privacyVersion, termsVersion: input.data.termsVersion, privacyAcceptedAt: now, termsAcceptedAt: now } });
  res.json({ ok: true, acceptedAt: now.toISOString() });
});

async function submitRequest(req: express.Request, res: express.Response, type: 'application' | 'discord-appeal' | 'ban-appeal', prefix: string, payload: Record<string, unknown>) {
  const userId = req.session.userId!;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  const duplicate = await prisma.submission.findFirst({ where: { userId, type, status: { in: ['PENDING', 'IN_REVIEW'] } } });
  if (duplicate) return res.status(409).json({ error: 'You already have an open request of this type.', id: duplicate.publicId });
  const publicId = await createIdentifier(prefix);
  const submission = await prisma.submission.create({ data: { publicId, type, userId, payload: payload as any } });
  const notice = await notifyBot(type === 'application' ? 'application' : 'appeal', type === 'application' ? 'New WVSP Staff Application' : `New WVSP ${type === 'ban-appeal' ? 'ER:LC Ban Appeal' : 'Discord Appeal'}`, publicId, user.discordId, payload);
  res.status(201).json({ id: submission.publicId, status: submission.status, notification: notice.delivered ? 'Sent for review' : notice.reason });
}
app.post('/api/applications', submissionLimit, acceptedUser, csrfRequired, async (req, res) => {
  const parsed = applicationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the application fields.', details: parsed.error.flatten().fieldErrors });
  try { await submitRequest(req, res, 'application', 'APP', parsed.data); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not save your application.' }); }
});
app.post('/api/appeals', submissionLimit, acceptedUser, csrfRequired, async (req, res) => {
  const parsed = appealSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the appeal fields.', details: parsed.error.flatten().fieldErrors });
  try { await submitRequest(req, res, 'discord-appeal', 'DAP', parsed.data); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not save your appeal.' }); }
});
app.post('/api/ban-appeals', submissionLimit, acceptedUser, csrfRequired, async (req, res) => {
  const parsed = banAppealSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the ER:LC ban appeal fields.', details: parsed.error.flatten().fieldErrors });
  try { await submitRequest(req, res, 'ban-appeal', 'GAP', parsed.data); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not save your ban appeal.' }); }
});
app.post('/api/stats/request-staff', submissionLimit, acceptedUser, csrfRequired, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a short message (1–1000 characters).' });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId! }, select: { discordId: true } });
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  const result = await notifyBot('staff-request', 'WVSP Staff Request', 'STAFF-REQUEST', user.discordId, parsed.data);
  res.status(result.delivered ? 200 : 503).json({ ok: result.delivered, status: result.delivered ? 'Request sent' : result.reason });
});
app.get('/api/stats/me', acceptedUser, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.session.userId! }, select: { discordId: true, username: true, globalName: true, avatar: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const botRoot = process.env.BOT_API_URL?.replace(/\/$/, '');
  if (!configured('BOT_API_URL', 'BOT_API_SECRET')) return res.json({ user: { ...user, avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128` : null }, roblox: null, stats: null, transcripts: [], status: 'Not configured' });
  const headers = { Authorization: `Bearer ${process.env.BOT_API_SECRET}` };
  const [roblox, transcripts] = await Promise.all([
    fetchJson(`${botRoot}/internal/wvsp/users/${encodeURIComponent(user.discordId)}/roblox`, headers),
    fetchJson(`${botRoot}/internal/wvsp/users/${encodeURIComponent(user.discordId)}/transcripts`, headers),
  ]);
  const robloxAccount = roblox?.linked === false ? null : roblox?.account ?? roblox?.roblox ?? roblox ?? null;
  const robloxId = robloxAccount?.robloxId ?? robloxAccount?.id;
  const playerStats = robloxId ? await fetchJson(`${botRoot}/internal/wvsp/players/${encodeURIComponent(String(robloxId))}/stats`, headers) : null;
  res.json({
    user: { ...user, avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128` : null },
    roblox: robloxAccount,
    stats: playerStats,
    transcripts: Array.isArray(transcripts) ? transcripts : Array.isArray(transcripts?.transcripts) ? transcripts.transcripts : [],
    sources: { roblox: roblox === null ? 'Unavailable' : robloxAccount ? 'Available' : 'Empty', stats: playerStats === null ? 'Unavailable' : 'Available', transcripts: transcripts === null ? 'Unavailable' : 'Available' },
  });
});

if (production) {
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  app.use(express.static(webDist));
  app.get(/^\/(?!api(?:\/|$)|auth(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}
app.listen(port, () => console.log(`WVSP API listening on ${port}`));
