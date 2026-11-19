import { describe, expect, it } from 'vitest';
import {
  DEVICE_LOCK_MS,
  GLOBAL_LOCK_MS,
  hashPassword,
  lockState,
  passwordProblem,
  verifyPassword,
  type Attempt,
} from '../../supabase/functions/_shared/adminLogin';

const MIN = 60_000;
const fail = (at: number, ip = '1.1.1.1', device = 'gerät-a'): Attempt => ({ at, ok: false, ip, device });
const T0 = 1_800_000_000_000;

describe('Versuchsbremse pro Gerät/IP', () => {
  it('4 Fehlversuche: noch offen, der 5. sperrt für 15 Minuten', () => {
    const four = [0, 1, 2, 3].map((i) => fail(T0 + i * MIN));
    expect(lockState(four, '1.1.1.1', 'gerät-a', T0 + 4 * MIN).locked).toBe(false);
    const five = [...four, fail(T0 + 4 * MIN)];
    const s = lockState(five, '1.1.1.1', 'gerät-a', T0 + 5 * MIN);
    expect(s).toEqual({ locked: true, scope: 'device', until: T0 + 4 * MIN + DEVICE_LOCK_MS });
    // nach Ablauf wieder offen
    expect(lockState(five, '1.1.1.1', 'gerät-a', T0 + 4 * MIN + DEVICE_LOCK_MS + 1).locked).toBe(false);
  });

  it('gilt für die IP auch mit neuem Gerät – und für das Gerät auch mit neuer IP', () => {
    const five = [0, 1, 2, 3, 4].map((i) => fail(T0 + i * MIN));
    expect(lockState(five, '1.1.1.1', 'neues-gerät', T0 + 5 * MIN).locked).toBe(true);
    expect(lockState(five, '9.9.9.9', 'gerät-a', T0 + 5 * MIN).locked).toBe(true);
    // ein anderes Gerät mit anderer IP ist nicht betroffen
    expect(lockState(five, '9.9.9.9', 'gerät-b', T0 + 5 * MIN).locked).toBe(false);
  });

  it('weit auseinanderliegende Fehlversuche sperren nicht', () => {
    const spread = [0, 1, 2, 3, 4].map((i) => fail(T0 + i * 20 * MIN));
    expect(lockState(spread, '1.1.1.1', 'gerät-a', T0 + 81 * MIN).locked).toBe(false);
  });

  it('abgewiesene Versuche während der Sperre verlängern sie nicht', () => {
    const five = [0, 1, 2, 3, 4].map((i) => fail(T0 + i * MIN));
    const during: Attempt[] = [...five, ...[6, 8, 10].map((m) => ({ ...fail(T0 + m * MIN), locked: true }))];
    expect(lockState(during, '1.1.1.1', 'gerät-a', T0 + 4 * MIN + DEVICE_LOCK_MS + 1).locked).toBe(false);
  });

  it('erfolgreiche Anmeldungen zählen nicht als Fehlversuch', () => {
    const mixed: Attempt[] = [0, 1, 2, 3].map((i) => fail(T0 + i * MIN));
    mixed.push({ at: T0 + 4 * MIN, ok: true, ip: '1.1.1.1', device: 'gerät-a' });
    expect(lockState(mixed, '1.1.1.1', 'gerät-a', T0 + 5 * MIN).locked).toBe(false);
  });
});

describe('Versuchsbremse insgesamt', () => {
  it('20 Fehlversuche (verteilt auf viele Geräte) schalten den Passwort-Login für 1 Stunde ab', () => {
    const many = Array.from({ length: 20 }, (_, i) => fail(T0 + i * 30 * MIN, `10.0.0.${i}`, `gerät-${i}`));
    const last = T0 + 19 * 30 * MIN;
    const s = lockState(many, '8.8.8.8', 'ganz-neu', last + MIN);
    expect(s).toEqual({ locked: true, scope: 'global', until: last + GLOBAL_LOCK_MS });
    expect(lockState(many, '8.8.8.8', 'ganz-neu', last + GLOBAL_LOCK_MS + 1).locked).toBe(false);
  });

  it('19 Fehlversuche: noch offen', () => {
    const many = Array.from({ length: 19 }, (_, i) => fail(T0 + i * 30 * MIN, `10.0.0.${i}`, `gerät-${i}`));
    expect(lockState(many, '8.8.8.8', 'ganz-neu', T0 + 19 * 30 * MIN).locked).toBe(false);
  });

  it('nur die letzten 24 Stunden zählen', () => {
    const old = Array.from({ length: 20 }, (_, i) => fail(T0 + i * MIN, `10.0.0.${i}`, `gerät-${i}`));
    expect(lockState(old, '8.8.8.8', 'ganz-neu', T0 + 25 * 3600_000).locked).toBe(false);
  });
});

describe('Passwort-Hash', () => {
  const salt = new Uint8Array(16).map((_, i) => i * 7);
  const hash = hashPassword('korrektes Pferd Batterie', salt);

  it('nur das richtige Passwort passt', () => {
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('Pferd');
    expect(verifyPassword('korrektes Pferd Batterie', hash)).toBe(true);
    expect(verifyPassword('korrektes Pferd Batteri', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('fehlender oder kaputter Hash lässt niemanden rein', () => {
    expect(verifyPassword('irgendwas', undefined)).toBe(false);
    expect(verifyPassword('irgendwas', '')).toBe(false);
    expect(verifyPassword('irgendwas', 'scrypt$x$y$z$abc$def')).toBe(false);
    expect(verifyPassword('irgendwas', 'bcrypt$2b$10$abc')).toBe(false);
  });

  it('Mindestanforderung', () => {
    expect(passwordProblem('kurz')).not.toBeNull();
    expect(passwordProblem('aaaaaaaaaaaaaaa')).not.toBeNull();
    expect(passwordProblem('Lange-Passphrase 2026')).toBeNull();
  });
});
