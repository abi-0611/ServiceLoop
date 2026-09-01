#!/usr/bin/env bash
#
# Nightly logical backup to GCS (phase 7.5).
#
#   scripts/backup.sh                    # uses DATABASE_URL and BACKUP_BUCKET
#   BACKUP_BUCKET=gs://... scripts/backup.sh
#
# A `pg_dump` *in addition to* Cloud SQL's own automated backups, and the
# duplication is deliberate. Cloud SQL's backups are excellent at restoring an
# instance and useless for the two things that actually happen: "restore one
# shop's data into a scratch database to answer a question", and "the project
# was deleted". A logical dump in a bucket in a different project answers both.
#
# `--format=custom` because it restores selectively — `pg_restore -t invoices`
# is how a support question gets answered without standing up a whole instance.

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
: "${BACKUP_BUCKET:?set BACKUP_BUCKET (gs://...)}"
PREFIX="${BACKUP_PREFIX:-serviceloop/pg}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DUMP="$(mktemp -t serviceloop-XXXXXX.dump)"
trap 'rm -f "${DUMP}"' EXIT

echo "==> pg_dump"
pg_dump "${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-owner --no-privileges \
  --file "${DUMP}"

BYTES="$(wc -c <"${DUMP}")"
# A dump that is suspiciously small is the classic silent backup failure: the
# connection succeeded, the schema dumped, and no data came with it. Better to
# fail the job loudly than to discover it during a restore.
if [[ "${BYTES}" -lt 100000 ]]; then
  echo "refusing: dump is only ${BYTES} bytes, which is too small to be a real database" >&2
  exit 1
fi

CHECKSUM="$(sha256sum "${DUMP}" | cut -d' ' -f1)"
TARGET="${BACKUP_BUCKET}/${PREFIX}/${STAMP}.dump"

echo "==> upload ${TARGET} (${BYTES} bytes, sha256 ${CHECKSUM})"
gsutil -q cp "${DUMP}" "${TARGET}"
# The checksum travels beside the dump rather than only in this log, so a
# restore can verify the bytes it fetched are the bytes that were written.
printf '%s  %s\n' "${CHECKSUM}" "$(basename "${TARGET}")" | gsutil -q cp - "${TARGET}.sha256"

echo "==> prune older than ${RETENTION_DAYS} days"
CUTOFF="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%d)"
gsutil ls "${BACKUP_BUCKET}/${PREFIX}/" | while read -r object; do
  name="$(basename "${object}")"
  day="${name%%T*}"
  # Only prune things that look like our own timestamped dumps. A prefix
  # somebody else shares must not be emptied by our retention policy.
  [[ "${day}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  if [[ "${day}" < "${CUTOFF}" ]]; then
    echo "    pruning ${name}"
    gsutil -q rm "${object}" || true
  fi
done

echo "Backup complete: ${TARGET}"
