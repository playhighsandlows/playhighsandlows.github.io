-- Tests für Admin-Login per Passwort und Admin-Geräte. Läuft in einer Transaktion, wird zurückgerollt.
-- Ausführen: npm run test:rls
begin;

insert into auth.users (id, instance_id, aud, role, email)
values
  ('00000000-0000-4000-8000-0000000aa001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'login-admin@example.invalid'),
  ('00000000-0000-4000-8000-0000000bb001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'login-player@example.invalid');
insert into public.admins (user_id) values ('00000000-0000-4000-8000-0000000aa001');
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000aa001', now() - interval '2 days', now(), 'Mozilla/5.0 (Linux; Android 16) Chrome/150'),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-0000000aa001', now() - interval '1 day', now(), 'Mozilla/5.0 (X11; Linux x86_64) Firefox/150'),
  ('00000000-0000-4000-8000-00000000d003', '00000000-0000-4000-8000-0000000aa001', now(), now(), 'Skript'),
  ('00000000-0000-4000-8000-00000000d009', '00000000-0000-4000-8000-0000000bb001', now(), now(), 'Spieler-Handy');
insert into public.admin_login_attempts (ok, ip, device, session_id) values
  (false, '203.0.113.7', 'geraet-x', null),
  (true, '203.0.113.8', 'geraet-y', '00000000-0000-4000-8000-00000000d002');

-- ================================================================ ohne Anmeldung / Spieler
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
do $$ begin
  begin perform 1 from public.admin_login_attempts; raise exception 'FAIL: anon liest Login-Versuche'; exception when insufficient_privilege then null; end;
  begin perform public.admin_devices(); raise exception 'FAIL: anon sieht Admin-Geräte'; exception when insufficient_privilege then null; end;
  begin perform public.admin_limit_session('00000000-0000-4000-8000-00000000d001', 999); raise exception 'FAIL: anon verlängert Sitzungen'; exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000bb001","role":"authenticated","session_id":"00000000-0000-4000-8000-00000000d009"}';
do $$
declare n int;
begin
  select count(*) into n from public.admin_login_attempts; if n > 0 then raise exception 'FAIL: Spieler liest Login-Versuche'; end if;
  begin insert into public.admin_login_attempts (ok) values (true); raise exception 'FAIL: Spieler trägt Login-Versuch ein'; exception when insufficient_privilege then null; end;
  begin perform public.admin_devices(); raise exception 'FAIL: Spieler sieht Admin-Geräte'; exception when insufficient_privilege then null; end;
  begin perform public.admin_sign_out_devices(null, false); raise exception 'FAIL: Spieler meldet Admin-Geräte ab'; exception when insufficient_privilege then null; end;
  begin perform public.admin_limit_session('00000000-0000-4000-8000-00000000d001', 999); raise exception 'FAIL: Spieler verlängert Sitzungen'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ================================================================ Admin
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000aa001","role":"authenticated","session_id":"00000000-0000-4000-8000-00000000d001"}';
do $$
declare d jsonb; n int;
begin
  select count(*) into n from public.admin_login_attempts; if n < 2 then raise exception 'FAIL: Admin sieht Login-Versuche nicht'; end if;
  d := public.admin_devices();
  if jsonb_array_length(d) <> 3 then raise exception 'FAIL: % Geräte statt 3 (fremde Sitzungen dabei?)', jsonb_array_length(d); end if;
  if (select count(*) from jsonb_array_elements(d) x where (x ->> 'current')::boolean) <> 1 then raise exception 'FAIL: aktuelles Gerät nicht markiert'; end if;
  if not (select (x ->> 'password')::boolean from jsonb_array_elements(d) x where x ->> 'id' = '00000000-0000-4000-8000-00000000d002') then raise exception 'FAIL: Passwort-Login nicht markiert'; end if;

  -- ein Gerät abmelden
  n := public.admin_sign_out_devices('00000000-0000-4000-8000-00000000d003', true);
  if n <> 1 then raise exception 'FAIL: einzelnes Gerät: % abgemeldet', n; end if;
  -- alle anderen abmelden: dieses bleibt, die Sitzung des Spielers bleibt sowieso
  n := public.admin_sign_out_devices(null, true);
  if n <> 1 then raise exception 'FAIL: alle anderen: % abgemeldet', n; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from auth.sessions where id = '00000000-0000-4000-8000-00000000d001') then raise exception 'FAIL: dieses Gerät wurde mit abgemeldet'; end if;
  if exists (select 1 from auth.sessions where id in ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000d003')) then raise exception 'FAIL: andere Geräte noch angemeldet'; end if;
  if not exists (select 1 from auth.sessions where id = '00000000-0000-4000-8000-00000000d009') then raise exception 'FAIL: fremde Sitzung (Spieler) gelöscht'; end if;
  if (select count(*) from public.admin_log where action like 'devices.%' and admin_id = '00000000-0000-4000-8000-0000000aa001') <> 2 then raise exception 'FAIL: Abmelden nicht protokolliert'; end if;
end $$;

-- alle abmelden, auch dieses
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000aa001","role":"authenticated","session_id":"00000000-0000-4000-8000-00000000d001"}';
do $$ begin
  if public.admin_sign_out_devices(null, false) <> 1 then raise exception 'FAIL: „alle abmelden“ ließ dieses Gerät angemeldet'; end if;
end $$;
reset role;

-- 30 Tage: nur die Edge Function (service_role) darf das Ablaufdatum setzen
insert into auth.sessions (id, user_id, created_at, updated_at) values ('00000000-0000-4000-8000-00000000d004', '00000000-0000-4000-8000-0000000aa001', now(), now());
set local role service_role;
select public.admin_limit_session('00000000-0000-4000-8000-00000000d004', 30);
reset role;
do $$ begin
  if (select not_after from auth.sessions where id = '00000000-0000-4000-8000-00000000d004') not between now() + interval '29 days' and now() + interval '31 days' then
    raise exception 'FAIL: Sitzung nicht auf 30 Tage begrenzt';
  end if;
end $$;

select 'Admin-Login-Tests bestanden' as result;
rollback;
