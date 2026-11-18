#!/bin/sh
# Roda os testes do banco num Postgres temporário local. Nunca toca no seu projeto do Supabase.
# Precisa do Postgres 15 ou mais novo instalado (macOS: brew install postgresql@16). Porta: 55493 em 127.0.0.1.
set -eu
export LC_ALL=C LANG=C
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
bin=${PG_BIN:-}
if [ -z "$bin" ] && [ -d /opt/homebrew/opt/postgresql@16/bin ]; then bin=/opt/homebrew/opt/postgresql@16/bin; fi
pg() { if [ -n "$bin" ]; then "$bin/$@"; else "$@"; fi; }
work=$(mktemp -d "${TMPDIR:-/tmp}/publicador-pg.XXXXXX")
trap 'pg pg_ctl -D "$work/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
pg initdb -D "$work/data" -A trust -U postgres >/dev/null
pg pg_ctl -D "$work/data" -o "-k '' -c listen_addresses=127.0.0.1 -p 55493" -l "$work/log" -w start >/dev/null
run() { PGOPTIONS='-c client_min_messages=warning' pg psql -h 127.0.0.1 -p 55493 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X "$@"; }
run -f "$here/stubs.sql"
for pass in 1 2; do
  for file in "$root"/supabase/migrations/*.sql; do run -f "$file" >/dev/null; done
done
run -f "$here/publisher.test.sql" >/dev/null
echo "Banco: todos os testes passaram."
