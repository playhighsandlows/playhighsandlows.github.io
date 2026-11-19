/**
 * Sitzung des Spielers – so, dass eine einmal gemachte Anmeldung auf dem Gerät bleibt.
 *
 * Fehler vorher: Scheiterte das Erneuern des Tokens am Netz (Handy gerade aufgewacht, kurz
 * offline), meldet supabase-js „keine Sitzung“, behält sie aber gespeichert. ensureSession hat
 * daraufhin anonym angemeldet – und diese neue Gast-Sitzung überschrieb das gespeicherte Konto.
 * Man war abgemeldet und musste sich neu anmelden.
 *
 * Jetzt: Anonym angemeldet wird nur, wenn wirklich keine Sitzung gespeichert ist. Liegt eine
 * (auch abgelaufene) Sitzung vor, wird sie erneuert; klappt das gerade nicht, gibt es eben
 * keinen Token (die KI-Prüfung meldet „nicht geprüft“) – das Konto bleibt erhalten.
 */
import type { Session } from '@supabase/supabase-js';

export interface SessionAuth {
  getSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
  refreshSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
  signInAnonymously(): Promise<{ data: { session: Session | null }; error: { message: string } | null }>;
}

/** Gespeicherte Sitzung (roh aus dem Speicher) – unabhängig davon, ob ihr Token noch gilt. */
export function storedSession(storage: Pick<Storage, 'getItem'> | null, key: string): { refresh_token?: string; user?: { is_anonymous?: boolean } } | null {
  try {
    const raw = storage?.getItem(key);
    const s = raw ? (JSON.parse(raw) as { refresh_token?: string; user?: { is_anonymous?: boolean } }) : null;
    return s && typeof s.refresh_token === 'string' && s.refresh_token ? s : null;
  } catch {
    return null;
  }
}

export function makeEnsureSession(auth: SessionAuth, storage: Pick<Storage, 'getItem'> | null, key: string) {
  let pending: Promise<string | null> | null = null;
  return function ensureSession(): Promise<string | null> {
    pending ??= (async () => {
      const { data, error } = await auth.getSession();
      if (data.session) return data.session.access_token;
      // Es liegt noch eine Sitzung im Speicher (Erneuern scheiterte nur am Netz): nicht ersetzen
      if (storedSession(storage, key)) {
        const again = await auth.refreshSession().catch(() => null);
        if (again?.data.session) return again.data.session.access_token;
        if (error) console.warn('Sitzung gerade nicht erneuerbar (bleibt gespeichert):', error);
        return null;
      }
      const { data: signIn, error: e } = await auth.signInAnonymously();
      if (e) {
        console.warn('Anonyme Anmeldung fehlgeschlagen:', e.message);
        return null;
      }
      return signIn.session?.access_token ?? null;
    })().finally(() => {
      // Nächster Aufruf fragt erneut (Token kann sich erneuert haben).
      pending = null;
    });
    return pending;
  };
}
