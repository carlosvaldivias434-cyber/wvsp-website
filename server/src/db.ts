import { PrismaClient } from '@prisma/client';
import session from 'express-session';

export const prisma = new PrismaClient();
const Store = session.Store;
export class PrismaSessionStore extends Store {
  get(sid: string, callback: (err?: unknown, session?: session.SessionData | null) => void) {
    prisma.session.findUnique({ where: { sid } }).then(row => {
      if (!row || row.expiresAt < new Date()) return callback(null, null);
      callback(null, JSON.parse(row.data) as session.SessionData);
    }).catch(callback);
  }
  set(sid: string, data: session.SessionData, callback?: (err?: unknown) => void) {
    const cookieExpiry = data.cookie?.expires ? new Date(data.cookie.expires) : new Date(Date.now() + 12 * 60 * 60 * 1000);
    prisma.session.upsert({ where: { sid }, create: { sid, data: JSON.stringify(data), expiresAt: cookieExpiry }, update: { data: JSON.stringify(data), expiresAt: cookieExpiry } }).then(() => callback?.()).catch(callback);
  }
  destroy(sid: string, callback?: (err?: unknown) => void) { prisma.session.deleteMany({ where: { sid } }).then(() => callback?.()).catch(callback); }
  touch(sid: string, data: session.SessionData, callback?: () => void) { this.set(sid, data, callback); }
}
