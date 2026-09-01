#!/usr/bin/env bash
#
# Post-deploy smoke suite (phase 7.7).
#
# Five checks, and each one exercises a *different layer* — that is the design
# constraint, not the count. A suite of five API reads would pass on a
# deployment whose database is unreachable, whose console is broken and whose
# adapters are all sandboxed.
#
#   API_BASE_URL=... CONSOLE_URL=... infra/deploy/smoke.sh
#
# Exits non-zero on the first failure, so it can gate a deploy.

set -euo pipefail

: "${API_BASE_URL:?}"
: "${CONSOLE_URL:?}"

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

echo "Smoke suite against ${API_BASE_URL}"

# 1. Liveness. The process is up.
curl -fsS --max-time 10 "${API_BASE_URL}/health" >/dev/null || fail "GET /health"
pass "liveness"

# 2. Readiness. It can reach Postgres and Redis — the check that separates
#    "the container started" from "the service works", and the one a naive
#    smoke test leaves out.
READY="$(curl -fsS --max-time 20 "${API_BASE_URL}/health/ready")" || fail "GET /health/ready"
echo "${READY}" | grep -q '"status":"ok"' || fail "readiness reports: ${READY}"
pass "readiness (postgres, redis)"

# 3. Not in demo mode. A production deploy that booted with DEMO_MODE forces
#    every sandbox adapter and would look perfectly healthy while reaching no
#    customer at all. This is the check that catches it.
if [[ "${EXPECT_DEMO_MODE:-false}" == "false" ]]; then
  echo "${READY}" | grep -q '"demoMode":false' || fail "the service booted in DEMO_MODE"
  pass "adapters are live (DEMO_MODE=false)"
fi

# 4. Metrics. Prometheus has something to scrape, and the series the alert
#    rules name actually exist on this deployment.
METRICS="$(curl -fsS --max-time 10 "${API_BASE_URL}/metrics")" || fail "GET /metrics"
echo "${METRICS}" | grep -q 'serviceloop_' || fail "no serviceloop metrics exported"
pass "metrics endpoint"

# 5. Authentication is actually on. An unauthenticated read of the board must
#    be refused — a guard misconfiguration is silent in every other check here,
#    and is the single worst outcome of a bad deploy.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${API_BASE_URL}/jobcards/board")"
[[ "${STATUS}" == "401" ]] || fail "GET /jobcards/board returned ${STATUS}, expected 401"
pass "authentication is enforced"

# 6. The console renders its sign-in page. Cheap, and it catches the
#    standalone-build failure mode where the server starts and every route
#    500s on a missing traced file.
curl -fsS --max-time 15 "${CONSOLE_URL}/login" >/dev/null || fail "GET ${CONSOLE_URL}/login"
pass "console serves /login"

echo "Smoke suite passed."
