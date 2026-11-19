/**
 * Edge Function "admin-login": Admin-Anmeldung per Passwort (ohne Google/GitHub/Discord).
 *
 *   POST { password, device }   (ohne Anmeldung aufrufbar – genau dafür ist sie da)
 *
 * - Passwort wird gegen den scrypt-Hash im Secret ADMIN_PASSWORD_HASH geprüft (nie im Klartext
 *   gespeichert, nie geloggt). Setzen: scripts/set-admin-password.sh
 * - Versuchsbremse (siehe _shared/adminLogin.ts): 5 Fehlversuche/15 min pro Gerät bzw. IP,
 *   20 Fehlversuche in 24 h → Passwort-Login 1 h global aus. Jeder Versuch steht in
 *   admin_login_attempts und admin_log.
 * - Erfolg: eine normale Sitzung des Admin-Kontos (Magic-Link-Token, serverseitig eingelöst),
 *   auf 30 Tage begrenzt. Rechte prüft danach wie immer is_admin()/RLS.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { DEVICE_SESSION_DAYS, GLOBAL_WINDOW_MS, lockState, verifyPassword, type Attempt } from '../_shared/adminLogin.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? firstKey('SUPABASE_PUBLISHABLE_KEYS');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? firstKey('SUPABASE_SECRET_KEYS');
function firstKey(name: string): string {
  try {
    const keys = JSON.parse(Deno.env.get(name) ?? '{}') as Record<string, string>;
    return keys.default ?? Object.values(keys)[0] ?? '';
  } catch {
    return '';
  }
}
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ALLOWED_ORIGINS = new Set(
  (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://playhighsandlows.github.io').split(',').map((s) => s.trim()).filter(Boolean),
);
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;
function corsHeaders(origin: string | null): Record<string, string> {
  const base = { 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
  return origin && (ALLOWED_ORIGINS.has(origin) || DEV_ORIGIN.test(origin)) ? { ...base, 'Access-Control-Allow-Origin': origin } : base;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function record(row: { ok: boolean; locked?: boolean; ip: string | null; device: string | null; ua: string | null; session_id?: string | null; admin_id?: string | null }, action: string, detail: Record<string, unknown> = {}) {
  await Promise.all([
    admin.from('admin_login_attempts').insert({ ok: row.ok, locked: row.locked ?? false, ip: row.ip, device: row.device, user_agent: row.ua, session_id: row.session_id ?? null }),
    admin.from('admin_log').insert({ admin_id: row.admin_id ?? null, action, target: row.device, detail: { ip: row.ip, ...detail } }),
  ]);
}

/** Das Admin-Konto, in das der Passwort-Login führt. */
async function adminUser(): Promise<{ id: string; email: string } | null> {
  const fixed = Deno.env.get('ADMIN_LOGIN_USER_ID');
  let id = fixed ?? null;
  if (!id) {
    const { data } = await admin.from('admins').select('user_id');
    const rows = (data ?? []) as { user_id: string }[];
    if (rows.length !== 1) return null; // mehrere Admins → ADMIN_LOGIN_USER_ID setzen
    id = rows[0].user_id;
  }
  const { data: isAdmin } = await admin.from('admins').select('user_id').eq('user_id', id).maybeSingle();
  if (!isAdmin) return null;
  const { data } = await admin.auth.admin.getUserById(id);
  return data.user?.email ? { id, email: data.user.email } : null;
}

const sessionIdOf = (accessToken: string): string | null => {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
};

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: { password?: unknown; device?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const device = typeof body.device === 'string' ? body.device.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null : null;
  const ip = (req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? '').split(',')[0].trim().slice(0, 64) || null;
  const ua = req.headers.get('user-agent')?.slice(0, 200) ?? null;
  const now = Date.now();

  // Versuche der letzten 24 h (nur die Bremse braucht sie)
  const { data: rows } = await admin
    .from('admin_login_attempts')
    .select('created_at, ok, locked, ip, device')
    .gte('created_at', new Date(now - GLOBAL_WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(500);
  const attempts: Attempt[] = ((rows ?? []) as { created_at: string; ok: boolean; locked: boolean; ip: string | null; device: string | null }[]).map((r) => ({
    at: Date.parse(r.created_at),
    ok: r.ok,
    locked: r.locked,
    ip: r.ip,
    device: r.device,
  }));

  const lock = lockState(attempts, ip, device, now);
  if (lock.locked) {
    await record({ ok: false, locked: true, ip, device, ua }, 'admin_login.locked', { scope: lock.scope });
    return json({ error: 'locked', scope: lock.scope, until: new Date(lock.until).toISOString() }, 429);
  }

  const hash = Deno.env.get('ADMIN_PASSWORD_HASH');
  if (!hash) return json({ error: 'not_configured' }, 503);
  const ok = verifyPassword(password, hash);
  if (!ok) {
    await record({ ok: false, ip, device, ua }, 'admin_login.failed');
    // Bremse auch zeitlich: falsche Passwörter antworten nie schnell
    await sleep(600);
    const after = lockState([...attempts, { at: now, ok: false, ip, device }], ip, device, Date.now());
    const mine = [...attempts, { at: now, ok: false, ip, device }].filter((a) => !a.ok && !a.locked && now - a.at < 15 * 60_000 && ((ip && a.ip === ip) || (device && a.device === device))).length;
    return json({ error: 'wrong', locked: after.locked ? { scope: after.scope, until: new Date(after.until).toISOString() } : null, left: Math.max(0, 5 - mine) }, 401);
  }

  const user = await adminUser();
  if (!user) {
    await record({ ok: false, ip, device, ua }, 'admin_login.no_admin');
    return json({ error: 'no_admin' }, 500);
  }
  // Sitzung des Admin-Kontos: Magic-Link-Token erzeugen und gleich hier einlösen (keine E-Mail)
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    console.error('generateLink', linkErr?.message);
    return json({ error: 'server_error' }, 500);
  }
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: verified, error: otpErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  const session = verified?.session;
  if (otpErr || !session) {
    console.error('verifyOtp', otpErr?.message);
    return json({ error: 'server_error' }, 500);
  }
  const sessionId = sessionIdOf(session.access_token);
  if (sessionId) await admin.rpc('admin_limit_session', { p_session: sessionId, p_days: DEVICE_SESSION_DAYS });
  await record({ ok: true, ip, device, ua, session_id: sessionId, admin_id: user.id }, 'admin_login.ok', { session: sessionId });
  return json({ access_token: session.access_token, refresh_token: session.refresh_token, expires_in_days: DEVICE_SESSION_DAYS });
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let res: Response;
  try {
    res = await handle(req);
  } catch (e) {
    console.error('admin-login', String(e).slice(0, 200));
    res = json({ error: 'server_error' }, 500);
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
});
