import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeEnsureSession } from './session';

/**
 * Supabase-Anbindung (optional). Das Frontend kennt nur URL und anon/publishable
 * Key – beide sind öffentlich. Ohne diese Variablen läuft das Spiel rein lokal
 * (keine KI-Prüfung, nichts wird gespeichert).
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        // Ein Client für alles (Spiel, Konto, Admin): verarbeitet auch den OAuth-Rücksprung (PKCE)
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'hal:v1:auth', detectSessionInUrl: true, flowType: 'pkce' },
      })
    : null;

export const SUPABASE_URL = url ?? '';
export const SUPABASE_ANON_KEY = anonKey ?? '';

/** Speicherschlüssel der Sitzung (localStorage; installierte App und Browser teilen ihn auf Android). */
export const AUTH_STORAGE_KEY = 'hal:v1:auth';

/**
 * Zugriffstoken des Spielers. Beim allerersten Mal wird anonym angemeldet – jeder Spieler
 * bekommt so eine feste ID, ganz ohne Registrierung. Eine gespeicherte Anmeldung wird nie
 * durch eine Gast-Sitzung ersetzt (siehe session.ts).
 */
export const ensureSession: () => Promise<string | null> = supabase
  ? makeEnsureSession(supabase.auth, typeof localStorage === 'undefined' ? null : localStorage, AUTH_STORAGE_KEY)
  : () => Promise.resolve(null);
