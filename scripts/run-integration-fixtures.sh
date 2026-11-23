#!/usr/bin/env bash
# Runs the connectors against every fixture project. Needs the language toolchains (php+composer, dotnet, swift, gradle/java, node+npm, dart).
# Usage: bash scripts/run-integration-fixtures.sh [language ...]   (default: all)
set -u
cd "$(dirname "$0")/../backend"
FX=tests/fixtures/integration
want="${*:-php typescript dart}"
for l in $want; do
  case $l in
    php) d=php; (cd $FX/php && composer install -q --no-interaction >/dev/null 2>&1);;
    csharp) d=csharp;; swift) d=swift;; kotlin) d=kotlin;;
    typescript) d=nest; (cd $FX/nest && npm install --silent >/dev/null 2>&1);;
    dart) d=dart; (cd $FX/dart && dart pub get >/dev/null 2>&1);;
    *) echo "skip $l"; continue;;
  esac
  PYTHONPATH=. python3 - "$l" "$FX/$d" <<'PY'
import os, sys
from phoenix_api import test_connectors as T
l, d = sys.argv[1], os.path.abspath(sys.argv[2])
for k in ("unit", "integration"):
    r = T.run_tests(l, k, d, retry=False)
    print(f"{l:11} {k:12} {'OK ' if r['ok'] else 'BAD'} {r['detail'][:90]} {[t['name'] for t in r['tests']]}")
PY
done
