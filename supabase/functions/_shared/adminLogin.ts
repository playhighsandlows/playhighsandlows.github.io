/**
 * Admin-Login per Passwort – reine Regeln ohne Netz/DB (getestet in src/domain/adminLogin.test.ts).
 *
 * Das Passwort steht nirgends im Klartext: Der Server kennt nur einen scrypt-Hash
 * (Secret ADMIN_PASSWORD_HASH, gesetzt mit scripts/set-admin-password.sh).
 *
 * Versuchsbremse:
 *  - pro Gerät bzw. IP: 5 Fehlversuche innerhalb von 15 Minuten → 15 Minuten gesperrt
 *  - insgesamt: 20 Fehlversuche innerhalb von 24 Stunden → Passwort-Login für 1 Stunde aus
 *  Während einer Sperre wird das Passwort gar nicht erst geprüft (zählt nicht als Fehlversuch,
 *  wird aber protokolliert).
 */
import { scryptSync, timingSafeEqual } from 'node:crypto';

export const DEVICE_MAX_FAILS = 5;
export const DEVICE_WINDOW_MS = 15 * 60_000;
export const DEVICE_LOCK_MS = 15 * 60_000;
export const GLOBAL_MAX_FAILS = 20;
export const GLOBAL_WINDOW_MS = 24 * 3600_000;
export const GLOBAL_LOCK_MS = 3600_000;
/** So lange bleibt ein Gerät nach dem Passwort-Login angemeldet. */
export const DEVICE_SESSION_DAYS = 30;

export interface Attempt {
  at: number;
  ok: boolean;
  /** Während einer Sperre abgewiesen (Passwort nicht geprüft) – zählt nicht als Fehlversuch */
  locked?: boolean;
  ip: string | null;
  device: string | null;
}

export type LockState = { locked: false } | { locked: true; scope: 'device' | 'global'; until: number };

/** Ist der Login für dieses Gerät/diese IP gerade gesperrt? (`attempts`: die letzten 24 h, beliebige Reihenfolge) */
export function lockState(attempts: readonly Attempt[], ip: string | null, device: string | null, now: number): LockState {
  const fails = attempts.filter((a) => !a.ok && !a.locked).sort((a, b) => b.at - a.at);

  // global: ≥ 20 Fehlversuche in 24 h → bis 1 h nach dem letzten Fehlversuch
  const recent = fails.filter((a) => now - a.at < GLOBAL_WINDOW_MS);
  if (recent.length >= GLOBAL_MAX_FAILS) {
    const until = recent[0].at + GLOBAL_LOCK_MS;
    if (until > now) return { locked: true, scope: 'global', until };
  }

  // Gerät/IP: ≥ 5 Fehlversuche in 15 min → bis 15 min nach dem 5. davon
  const mine = fails.filter((a) => (ip !== null && a.ip === ip) || (device !== null && a.device === device));
  const window = mine.filter((a) => now - a.at < DEVICE_WINDOW_MS + DEVICE_LOCK_MS);
  for (let i = 0; i + DEVICE_MAX_FAILS - 1 < window.length; i++) {
    const newest = window[i];
    const fifth = window[i + DEVICE_MAX_FAILS - 1];
    if (newest.at - fifth.at < DEVICE_WINDOW_MS) {
      const until = newest.at + DEVICE_LOCK_MS;
      if (until > now) return { locked: true, scope: 'device', until };
    }
  }
  return { locked: false };
}

// ---------------------------------------------------------------- Passwort-Hash (scrypt)

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/** Hash im Format scrypt$N$r$p$salt(base64)$hash(base64). Nur für das Setz-Skript und Tests. */
export function hashPassword(password: string, salt: Uint8Array): string {
  const key = scryptSync(password.normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64(salt), b64(key)].join('$');
}

/** Passwort gegen den gespeicherten Hash prüfen (zeitkonstant). Kaputter/fehlender Hash → false. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored || typeof password !== 'string' || password.length === 0 || password.length > 200) return false;
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 1 << 17) return false;
  const salt = unb64(parts[4]);
  const expected = unb64(parts[5]);
  if (!salt.length || expected.length < 16) return false;
  const key = scryptSync(password.normalize('NFC'), salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

/** Mindestanforderung an das Admin-Passwort (das Setz-Skript prüft sie). */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'mindestens 12 Zeichen';
  if (password.length > 200) return 'höchstens 200 Zeichen';
  if (new Set(password).size < 6) return 'zu wenige verschiedene Zeichen';
  return null;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
function unb64(s: string): Uint8Array {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}
