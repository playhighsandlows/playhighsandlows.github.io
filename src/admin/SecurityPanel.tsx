import { useCallback, useEffect, useState } from 'react';
import { Panel, PxButton } from '../components/px';
import { adminDb, loadDevices, loadLoginAttempts, passwordLogin, signOutDevices, type AdminDevice, type LoginAttempt, type PasswordLoginResult } from './adminApi';

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');
/** Kurze Gerätebeschreibung aus dem User-Agent. */
function deviceName(ua: string | null): string {
  if (!ua) return 'Unbekanntes Gerät';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /node|undici|Deno/i.test(ua) ? 'Skript' : '';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

/** Login-Formular „Mit Admin-Passwort anmelden“ (Admin-Bereich, ohne Google/GitHub/Discord). */
export function PasswordLoginForm() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PasswordLoginResult | null>(null);
  const submit = async () => {
    if (!adminDb || !password || busy) return;
    setBusy(true);
    const r = await passwordLogin(adminDb, password);
    setBusy(false);
    setResult(r);
    if (!r.ok) setPassword('');
  };
  const msg = (() => {
    if (!result || result.ok) return null;
    if (result.error === 'wrong')
      return result.lockedUntil
        ? `Falsches Passwort – ${result.scope === 'global' ? 'Passwort-Login ist jetzt für alle gesperrt' : 'dieses Gerät ist gesperrt'} bis ${time(result.lockedUntil)}.`
        : `Falsches Passwort. Noch ${result.left} Versuch${result.left === 1 ? '' : 'e'}, dann 15 Minuten Sperre.`;
    if (result.error === 'locked')
      return result.scope === 'global' ? `Zu viele Fehlversuche insgesamt – Passwort-Login gesperrt bis ${time(result.lockedUntil)}.` : `Zu viele Fehlversuche – dieses Gerät ist gesperrt bis ${time(result.lockedUntil)}.`;
    if (result.error === 'not_configured') return 'Es ist noch kein Admin-Passwort gesetzt (scripts/set-admin-password.sh).';
    if (result.error === 'offline') return 'Keine Verbindung.';
    return 'Anmeldung fehlgeschlagen.';
  })();
  return (
    <form
      className="mt-4 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="block">
        <span className="font-tiny text-xs uppercase opacity-75">Admin-Passwort</span>
        <span className="px-field px-field-dark mt-1 block">
          <input
            type="password"
            name="admin-password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            className="w-full bg-transparent px-1 text-xl"
            aria-describedby="admin-login-msg"
          />
        </span>
      </label>
      <PxButton tone="teal" type="submit" disabled={!password || busy} className="mt-2 w-full text-lg">
        {busy ? 'Prüfe …' : 'Mit Admin-Passwort anmelden'}
      </PxButton>
      <p id="admin-login-msg" role="status" className="mt-2 min-h-5 text-sm text-[#ffb3a0]">
        {msg}
      </p>
      <p className="text-xs opacity-60">Max. 5 Fehlversuche pro Gerät, danach 15 Minuten Sperre. Das Gerät bleibt 30 Tage angemeldet.</p>
    </form>
  );
}

/** Dashboard: Admin-Geräte (abmelden) und Login-Versuche. */
export function SecurityPanel() {
  const db = adminDb!;
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [attempts, setAttempts] = useState<LoginAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    Promise.all([loadDevices(db), loadLoginAttempts(db, 40)])
      .then(([d, a]) => {
        setDevices(d);
        setAttempts(a);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [db]);
  useEffect(() => refresh(), [refresh]);

  const signOut = async (id: string | null, keepCurrent = true) => {
    if (id === null && !confirm(keepCurrent ? 'Alle anderen Geräte abmelden?' : 'Alle Geräte abmelden – auch dieses?')) return;
    setBusy(true);
    await signOutDevices(db, id, keepCurrent).catch((e) => setError(String(e)));
    setBusy(false);
    if (!keepCurrent && id === null) await db.auth.signOut({ scope: 'local' });
    refresh();
  };
  const fails24h = attempts?.filter((a) => !a.ok && !a.locked && Date.now() - Date.parse(a.created_at) < 24 * 3600_000).length ?? 0;

  return (
    <div className="grid gap-3">
      {error && <p className="text-sm text-[#ffb3a0]">{error}</p>}
      <Panel tone="stone" className="px-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">🔐 Admin-Geräte</h2>
          <div className="flex gap-1">
            <PxButton tone="stone" small className="text-sm" disabled={busy} onClick={() => void signOut(null, true)}>
              Alle anderen abmelden
            </PxButton>
            <PxButton tone="coral" small className="text-sm" disabled={busy} onClick={() => void signOut(null, false)}>
              Alle abmelden
            </PxButton>
          </div>
        </div>
        <ul className="mt-2 grid gap-1" data-devices>
          {devices?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-white/10 pt-1 text-sm">
              <span className="min-w-0 flex-1 font-bold">
                {deviceName(d.user_agent)} {d.current && <span className="text-[#7ec850]">(dieses Gerät)</span>} {d.password && <span title="über das Admin-Passwort angemeldet">🔑</span>}
              </span>
              <span className="opacity-75">angemeldet {time(d.created_at)}</span>
              <span className="opacity-75">zuletzt {time(d.last_seen)}</span>
              {d.expires_at && <span className="opacity-75">bis {time(d.expires_at)}</span>}
              {d.ip && <span className="font-mono text-xs opacity-60">{d.ip}</span>}
              {!d.current && (
                <button type="button" className="underline decoration-dotted underline-offset-4" disabled={busy} onClick={() => void signOut(d.id)}>
                  abmelden
                </button>
              )}
            </li>
          ))}
          {devices?.length === 0 && <li className="text-sm opacity-70">Keine Geräte.</li>}
        </ul>
      </Panel>

      <Panel tone="stone" className="px-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-bold">Login-Versuche (Admin-Passwort)</h2>
          <span className={`text-sm ${fails24h >= 15 ? 'text-[#ffb3a0]' : 'opacity-75'}`}>{fails24h}/20 Fehlversuche in 24 h</span>
        </div>
        <ul className="mt-2 grid gap-0.5 text-sm" data-attempts>
          {attempts?.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-3">
              <span className="w-28 shrink-0 tabular-nums opacity-75">{time(a.created_at)}</span>
              <span className={`w-24 shrink-0 font-bold ${a.ok ? 'text-[#7ec850]' : a.locked ? 'text-[#f2b53a]' : 'text-[#ffb3a0]'}`}>{a.ok ? 'erfolgreich' : a.locked ? 'gesperrt' : 'falsch'}</span>
              <span className="min-w-0 flex-1 truncate opacity-80">{deviceName(a.user_agent)}</span>
              <span className="font-mono text-xs opacity-60">{a.ip ?? '–'}</span>
            </li>
          ))}
          {attempts?.length === 0 && <li className="opacity-70">Noch keine Versuche.</li>}
        </ul>
      </Panel>
    </div>
  );
}
