#!/usr/bin/env bash
# Admin-Passwort setzen bzw. ändern (Admin-Login ohne Google/GitHub/Discord).
#
#   bash scripts/set-admin-password.sh
#
# Das Passwort wird verdeckt eingegeben (read -s), nur auf diesem Rechner gehasht (scrypt) und
# ausschließlich als Hash im Supabase-Secret ADMIN_PASSWORD_HASH gespeichert. Es landet weder in
# der Shell-History noch in Argumenten, Dateien, Logs oder im Repo.
set -euo pipefail
cd "$(dirname "$0")/.."

read -rsp 'Neues Admin-Passwort (mind. 12 Zeichen): ' pw1; echo
read -rsp 'Noch einmal: ' pw2; echo
if [[ "$pw1" != "$pw2" ]]; then
  unset pw1 pw2
  echo 'Die Eingaben stimmen nicht überein – nichts geändert.' >&2
  exit 1
fi
unset pw2

hash="$(printf '%s' "$pw1" | npx --yes tsx scripts/hash-admin-password.ts)"
unset pw1

# Secret über eine nur für mich lesbare, kurzlebige Datei setzen (nicht als Argument → nicht in ps)
tmp="$(umask 077; mktemp)"
trap 'rm -f "$tmp"' EXIT
printf 'ADMIN_PASSWORD_HASH=%s\n' "$hash" > "$tmp"
unset hash
npx supabase secrets set --env-file "$tmp"
echo 'Admin-Passwort gesetzt. Gilt sofort für den Admin-Login (/admin → „Mit Admin-Passwort anmelden“).'
