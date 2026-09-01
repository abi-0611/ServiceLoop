#!/usr/bin/env bash
#
# Roll back to the previous Cloud Run revision (phase 7.7).
#
#   infra/deploy/rollback.sh staging
#   infra/deploy/rollback.sh prod [revision-name]
#
# What this does and does not do is the whole point, and the drill in
# `docs/runbooks/rollback.md` makes an operator say it out loud before running
# it: **this rolls back code, not data.**
#
# The migration policy (expand-migrate-contract, enforced by
# `scripts/lint-migrations.mjs`) is what makes that safe: a release only ever
# adds columns, so the previous revision can read the new schema. A release that
# dropped a column could not be rolled back this way at all, which is why the
# linter refuses one without a two-release window.

set -euo pipefail

ENVIRONMENT="${1:-}"
TARGET_REVISION="${2:-}"
if [[ "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "usage: $0 <staging|prod> [revision]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "${REPO_ROOT}/infra/deploy/env.${ENVIRONMENT}.sh"

for service in api workers console; do
  name="serviceloop-${service}-${ENVIRONMENT}"

  if [[ -n "${TARGET_REVISION}" && "${service}" == "api" ]]; then
    revision="${TARGET_REVISION}"
  else
    # The second-newest revision: the newest is what we are rolling back *from*.
    revision="$(gcloud run revisions list \
      --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
      --service "${name}" --format 'value(metadata.name)' \
      --sort-by '~metadata.creationTimestamp' --limit 2 | tail -1)"
  fi

  if [[ -z "${revision}" ]]; then
    echo "no previous revision for ${name}; nothing to roll back" >&2
    continue
  fi

  echo "==> ${name} -> ${revision}"
  gcloud run services update-traffic "${name}" \
    --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
    --to-revisions "${revision}=100" --quiet
done

echo
echo "Traffic moved. Now confirm it actually worked:"
echo "  API_BASE_URL=${API_URL} CONSOLE_URL=${CONSOLE_URL} infra/deploy/smoke.sh"
echo
echo "If this rollback followed a data-affecting incident, read"
echo "docs/runbooks/rollback.md#after-a-rollback before declaring it over."
