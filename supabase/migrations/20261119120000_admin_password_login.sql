-- Admin-Login per Passwort (ohne Google/GitHub/Discord) und Admin-Geräte.
--
-- Das Passwort selbst steht nirgends: Die Edge Function "admin-login" prüft es gegen einen
-- scrypt-Hash im Secret ADMIN_PASSWORD_HASH. Sie protokolliert jeden Versuch hier und erzwingt
-- die Versuchsbremse (5 Fehlversuche/15 min pro Gerät bzw. IP, 20 in 24 h → 1 h global aus).
-- Nach Erfolg bekommt das Gerät eine normale Sitzung des Admin-Kontos (30 Tage gültig). Die
-- Rechte prüfen wie bisher is_admin()/RLS – die Anmeldeart ändert daran nichts.

create table public.admin_login_attempts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  ok boolean not null,
  -- abgewiesen, weil gesperrt (Passwort nicht geprüft)
  locked boolean not null default false,
  ip text check (char_length(ip) <= 64),
  device text check (char_length(device) <= 64),
  user_agent text check (char_length(user_agent) <= 200),
  -- bei Erfolg: die neue Sitzung (für die Geräteliste)
  session_id uuid
);
create index admin_login_attempts_created_idx on public.admin_login_attempts (created_at desc);
alter table public.admin_login_attempts enable row level security;
create policy "Admins lesen Login-Versuche" on public.admin_login_attempts for select to authenticated using ((select public.is_admin()));
revoke all on table public.admin_login_attempts from anon, authenticated;
grant select on table public.admin_login_attempts to authenticated;
grant all on table public.admin_login_attempts to service_role;

-- Sitzung nach Passwort-Login auf 30 Tage begrenzen (nur die Edge Function, service_role)
create function public.admin_limit_session(p_session uuid, p_days integer) returns void
  language sql security definer set search_path = ''
as $$
  update auth.sessions set not_after = now() + make_interval(days => p_days) where id = p_session;
$$;
revoke all on function public.admin_limit_session(uuid, integer) from public, anon, authenticated;
grant execute on function public.admin_limit_session(uuid, integer) to service_role;

-- ---------------------------------------------------------------- Admin-Geräte

-- Angemeldete Geräte des eigenen Admin-Kontos (alle Anmeldearten)
create function public.admin_devices() returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  current_session uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  perform public.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'created_at', s.created_at,
      'last_seen', greatest(s.updated_at, s.refreshed_at::timestamptz),
      'user_agent', left(s.user_agent, 200),
      'ip', host(s.ip),
      'expires_at', s.not_after,
      'current', s.id = current_session,
      'password', exists (select 1 from public.admin_login_attempts a where a.session_id = s.id and a.ok)
    ) order by greatest(s.updated_at, s.refreshed_at::timestamptz) desc)
    from auth.sessions s where s.user_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.admin_devices() from public, anon;
grant execute on function public.admin_devices() to authenticated;

-- Ein Gerät abmelden bzw. alle (wahlweise außer diesem)
create function public.admin_sign_out_devices(p_session uuid default null, p_keep_current boolean default true) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  current_session uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  n integer;
begin
  perform public.require_admin();
  delete from auth.sessions s
  where s.user_id = auth.uid()
    and (p_session is null or s.id = p_session)
    and (not p_keep_current or current_session is null or s.id <> current_session);
  get diagnostics n = row_count;
  insert into public.admin_log (admin_id, action, target, detail)
  values (auth.uid(), case when p_session is null then 'devices.sign_out_all' else 'devices.sign_out' end, p_session::text,
          jsonb_build_object('count', n, 'keep_current', p_keep_current));
  return n;
end;
$$;
revoke all on function public.admin_sign_out_devices(uuid, boolean) from public, anon;
grant execute on function public.admin_sign_out_devices(uuid, boolean) to authenticated;
