#!/usr/bin/env bash
#
# Restore the newest backup into a scratch database and *prove* it works
# (phase 7.5).
#
#   scripts/restore-and-verify.sh
#   BACKUP_OBJECT=gs://.../2026-09-01T02-00-00Z.dump scripts/restore-and-verify.sh
#
# The second half is the point, and it is the half every backup process
# forgets. A restore that completes is not a restore that worked: the schema can
# come back without the data, the data without the constraints, or the whole
# thing with an audit chain that no longer verifies. So this script restores and
# then runs the *product's own* checks against the restored database — the
# migration ledger, the audit chain, and a metrics recompute that must reproduce
# the stored rollups exactly.
#
# The acceptance gate is "restore-and-verify under 30 minutes, documented". The
# script prints its own elapsed time so the number in the runbook is measured
# rather than remembered.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTED="$(date +%s)"

: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
PREFIX="${BACKUP_PREFIX:-serviceloop/pg}"
SCRATCH_DB="${SCRATCH_DB:-serviceloop_restore_check}"
ADMIN_URL="${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (a superuser URL that can CREATE DATABASE)}"

OBJECT="${BACKUP_OBJECT:-$(gsutil ls "${BACKUP_BUCKET}/${PREFIX}/*.dump" | sort | tail -1)}"
[[ -n "${OBJECT}" ]] || { echo "no backup found under ${BACKUP_BUCKET}/${PREFIX}" >&2; exit 1; }

DUMP="$(mktemp -t serviceloop-restore-XXXXXX.dump)"
trap 'rm -f "${DUMP}"' EXIT

echo "==> fetching ${OBJECT}"
gsutil -q cp "${OBJECT}" "${DUMP}"

# Verify the bytes before trusting them. A truncated upload restores partially
# and looks like data corruption three steps later.
if gsutil -q stat "${OBJECT}.sha256" 2>/dev/null; then
  EXPECTED="$(gsutil cat "${OBJECT}.sha256" | cut -d' ' -f1)"
  ACTUAL="$(sha256sum "${DUMP}" | cut -d' ' -f1)"
  [[ "${EXPECTED}" == "${ACTUAL}" ]] || { echo "checksum mismatch: ${ACTUAL} != ${EXPECTED}" >&2; exit 1; }
  echo "    checksum ok"
fi

echo "==> recreating ${SCRATCH_DB}"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${SCRATCH_DB}"

SCRATCH_URL="${ADMIN_URL%/*}/${SCRATCH_DB}"

echo "==> restoring"
# `--exit-on-error` is not used: a custom-format dump restoring into a fresh
# database emits harmless errors for extensions and roles that already exist,
# and failing on those would make the drill unrunnable. The verification below
# is what decides whether the restore is good, which is a stronger check than
# an exit code anyway.
pg_restore --dbname "${SCRATCH_URL}" --no-owner --no-privileges --jobs 4 "${DUMP}" || true

echo
echo "==> verifying the restored database"

# 1. Every migration in the journal is recorded as applied. A dump taken
#    mid-deploy can restore a schema the code cannot read.
APPLIED="$(psql "${SCRATCH_URL}" -tAc 'select count(*) from drizzle.__drizzle_migrations')"
EXPECTED_MIGRATIONS="$(node -e "
  const journal = require('${REPO_ROOT}/packages/db/migrations/meta/_journal.json');
  process.stdout.write(String(journal.entries.length));
")"
echo "    migrations applied: ${APPLIED} (expected ${EXPECTED_MIGRATIONS})"
[[ "${APPLIED}" == "${EXPECTED_MIGRATIONS}" ]] || { echo "migration ledger mismatch" >&2; exit 1; }

# 2. There is actually data. A schema-only restore passes every structural
#    check and is worthless.
ROWS="$(psql "${SCRATCH_URL}" -tAc 'select count(*) from job_cards')"
echo "    job cards restored: ${ROWS}"
[[ "${ROWS}" -gt 0 ]] || { echo "no job cards in the restored database" >&2; exit 1; }

# 3. The audit chain verifies. This is the check that distinguishes a good
#    restore from a plausible one: the chain is hash-linked, so any row lost,
#    reordered or truncated in transit breaks it.
DATABASE_URL="${SCRATCH_URL}" pnpm --dir "${REPO_ROOT}" --filter @serviceloop/db exec \
  tsx src/cli/verify-chain.ts

# 4. The metrics fold reproduces the stored rollups exactly. The strongest
#    check available, because it re-derives numbers from the event log and
#    compares them to what was stored — a partial restore of `events_outbox`
#    fails here and nowhere else.
DATABASE_URL="${SCRATCH_URL}" pnpm --dir "${REPO_ROOT}" metrics:recompute

ELAPSED=$(( $(date +%s) - STARTED ))
echo
echo "Restore verified in $((ELAPSED / 60))m $((ELAPSED % 60))s (target: under 30 minutes)."
echo "Scratch database ${SCRATCH_DB} left in place for inspection; drop it when done."
