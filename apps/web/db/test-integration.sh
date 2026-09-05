#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pg_bin="${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
test_root="$(mktemp -d /tmp/signloop-tests.XXXXXX)"
trap '"$pg_bin/pg_ctl" -D "$test_root/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$test_root"' EXIT
"$pg_bin/initdb" -D "$test_root/data" -A trust -U signloop_test >/dev/null
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/server.log" -o "-k $test_root -p 55439 -c listen_addresses=''" start >/dev/null
"$pg_bin/createdb" -h "$test_root" -p 55439 -U signloop_test signloop_test
SIGNLOOP_TEST_DATABASE_URL="postgresql://signloop_test@localhost:55439/signloop_test?host=$test_root" bun run test -- lib/server-db.integration.test.ts
