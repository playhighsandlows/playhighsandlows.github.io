import { describe, expect, it, vi } from 'vitest';
import { makeEnsureSession, type SessionAuth } from './session';

const KEY = 'hal:v1:auth';
const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null };
};
const session = (token: string, anonymous = false) => ({ access_token: token, refresh_token: `r-${token}`, user: { is_anonymous: anonymous } }) as never;
const auth = (over: Partial<SessionAuth>): SessionAuth & { signInAnonymously: ReturnType<typeof vi.fn> } => ({
  getSession: async () => ({ data: { session: null }, error: null }),
  refreshSession: async () => ({ data: { session: null }, error: new Error('offline') }),
  signInAnonymously: vi.fn(async () => ({ data: { session: session('gast', true) }, error: null })),
  ...over,
}) as never;

describe('Sitzung bleibt erhalten (Regression „muss mich ständig neu anmelden“)', () => {
  it('Erneuern scheitert am Netz: KEINE Gast-Sitzung über das gespeicherte Konto', async () => {
    // supabase-js: Token abgelaufen, Refresh scheitert am Netz → session null, aber gespeichert bleibt sie
    const stored = memory({ [KEY]: JSON.stringify({ access_token: 'alt', refresh_token: 'r-konto', user: { is_anonymous: false } }) });
    const a = auth({ getSession: async () => ({ data: { session: null }, error: new Error('Failed to fetch') }) });
    const ensure = makeEnsureSession(a, stored, KEY);
    expect(await ensure()).toBeNull();
    expect(a.signInAnonymously).not.toHaveBeenCalled();
  });

  it('… und sobald das Netz wieder da ist, gilt wieder das Konto', async () => {
    const stored = memory({ [KEY]: JSON.stringify({ access_token: 'alt', refresh_token: 'r-konto', user: { is_anonymous: false } }) });
    let online = false;
    const a = auth({
      getSession: async () => ({ data: { session: online ? session('konto') : null }, error: online ? null : new Error('Failed to fetch') }),
      refreshSession: async () => ({ data: { session: online ? session('konto') : null }, error: null }),
    });
    const ensure = makeEnsureSession(a, stored, KEY);
    expect(await ensure()).toBeNull();
    online = true;
    expect(await ensure()).toBe('konto');
    expect(a.signInAnonymously).not.toHaveBeenCalled();
  });

  it('getSession leer, aber zweiter Versuch (refreshSession) klappt', async () => {
    const stored = memory({ [KEY]: JSON.stringify({ refresh_token: 'r-konto', user: {} }) });
    const a = auth({ refreshSession: async () => ({ data: { session: session('neu') }, error: null }) });
    expect(await makeEnsureSession(a, stored, KEY)()).toBe('neu');
    expect(a.signInAnonymously).not.toHaveBeenCalled();
  });

  it('gültige Sitzung: einfach deren Token', async () => {
    const a = auth({ getSession: async () => ({ data: { session: session('ok') }, error: null }) });
    expect(await makeEnsureSession(a, memory(), KEY)()).toBe('ok');
    expect(a.signInAnonymously).not.toHaveBeenCalled();
  });

  it('erster Start ohne gespeicherte Sitzung: anonym anmelden (wie bisher)', async () => {
    const a = auth({});
    expect(await makeEnsureSession(a, memory(), KEY)()).toBe('gast');
    expect(a.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('kaputter Speicherinhalt zählt als „keine Sitzung“', async () => {
    const a = auth({});
    expect(await makeEnsureSession(a, memory({ [KEY]: '{kaputt' }), KEY)()).toBe('gast');
  });

  it('gleichzeitige Aufrufe teilen sich eine Anmeldung', async () => {
    const a = auth({});
    const ensure = makeEnsureSession(a, memory(), KEY);
    const [x, y] = await Promise.all([ensure(), ensure()]);
    expect(x).toBe('gast');
    expect(y).toBe('gast');
    expect(a.signInAnonymously).toHaveBeenCalledTimes(1);
  });
});
