#!/usr/bin/env bash
#
# One-command deploy to Cloud Run (phase 7.7).
#
#   infra/deploy/deploy.sh staging
#   infra/deploy/deploy.sh prod
#
# Scripts rather than Terraform, and that is a considered choice rather than
# laziness. The phase file allows it if it "stays under a day", and it does:
# this deployment is three Cloud Run services, one Cloud SQL instance, one
# Memorystore instance and a handful of secrets. Terraform's value is managing
# drift across dozens of resources and several people; with two people and nine
# resources, its state file is the most fragile thing in the system. When the
# resource count doubles, port this to Terraform — `docs/deploy.md` says so and
# says what to port first.
#
# Everything below is idempotent. Running it twice is how a deploy is retried.

set -euo pipefail

ENVIRONMENT="${1:-}"
if [[ "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "usage: $0 <staging|prod>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "${REPO_ROOT}/infra/deploy/env.${ENVIRONMENT}.sh"

: "${GCP_PROJECT:?set in env.${ENVIRONMENT}.sh}"
: "${GCP_REGION:?set in env.${ENVIRONMENT}.sh}"
: "${ARTIFACT_REPO:?set in env.${ENVIRONMENT}.sh}"

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
DIRTY=""
if ! git -C "${REPO_ROOT}" diff --quiet HEAD; then DIRTY="-dirty"; fi
TAG="${GIT_SHA}${DIRTY}"
IMAGE_BASE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${ARTIFACT_REPO}"

# A dirty tree deploying to production is how an unreviewed change reaches a
# customer. Staging is allowed it, because staging is where you try things.
if [[ -n "${DIRTY}" && "${ENVIRONMENT}" == "prod" ]]; then
  echo "refusing: the working tree has uncommitted changes and the target is prod" >&2
  exit 1
fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Deploying ${TAG} to ${ENVIRONMENT} (${GCP_PROJECT} / ${GCP_REGION})"

# --------------------------------------------------------------------- build
say "Building images"
gcloud builds submit "${REPO_ROOT}" \
  --project "${GCP_PROJECT}" \
  --region "${GCP_REGION}" \
  --config "${REPO_ROOT}/infra/deploy/cloudbuild.yaml" \
  --substitutions "_TAG=${TAG},_IMAGE_BASE=${IMAGE_BASE}"

# ----------------------------------------------------------------- migrations
#
# Run as a Cloud Run *job*, not from a laptop, and not as a container
# entrypoint. Three reasons, and the third is the one that bites:
#
#   1. A laptop needs a database password and a route into the VPC. Neither
#      should exist on a laptop.
#   2. A migration in the service's entrypoint runs once per instance, so an
#      autoscale event during a deploy runs it concurrently with itself.
#   3. A job's exit code is the deploy's gate. An entrypoint that fails a
#      migration and then starts anyway is a service running against a schema
#      it does not understand, which is how a column read as null gets written
#      as a default.
say "Running migrations"
gcloud run jobs deploy "serviceloop-migrate-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
  --image "${IMAGE_BASE}/api:${TAG}" \
  --command "/nodejs/bin/node" \
  --args "/app/node_modules/.bin/tsx,/app/packages/db/src/cli/migrate.ts" \
  --set-secrets "DATABASE_URL=serviceloop-database-url-${ENVIRONMENT}:latest" \
  --set-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --max-retries 0 \
  --task-timeout 10m \
  --quiet

gcloud run jobs execute "serviceloop-migrate-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" --wait

# -------------------------------------------------------------------- deploy
#
# `min-instances` is where the money and the correctness meet.
#
# The API holds 1 because a cold start behind a WhatsApp webhook means Meta
# times out and retries, and a retried webhook is a duplicated inbound message
# that only the idempotency key saves us from.
#
# The workers hold 1 because they *are* the timers: an escalation rung and a
# quiet-hours release fire from a polling loop, and a worker scaled to zero is a
# ladder that never climbs. This is the single most expensive line in the
# deployment and the one most likely to be "optimised" by somebody who has not
# read this comment.
#
# The console scales to zero. Nobody is looking at a board at 3am, and a
# two-second cold start on the first page view of the morning is fine.
say "Deploying api"
gcloud run deploy "serviceloop-api-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
  --image "${IMAGE_BASE}/api:${TAG}" \
  --platform managed \
  --min-instances 1 --max-instances "${API_MAX_INSTANCES:-10}" \
  --cpu 1 --memory 1Gi \
  --concurrency 80 \
  --timeout 120 \
  --port 3001 \
  --set-env-vars "NODE_ENV=production,DEPLOY_ENV=${ENVIRONMENT},API_PORT=3001,${API_ENV_VARS}" \
  --set-secrets "${SHARED_SECRETS}" \
  --set-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --service-account "${RUNTIME_SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --quiet

say "Deploying workers"
gcloud run deploy "serviceloop-workers-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
  --image "${IMAGE_BASE}/workers:${TAG}" \
  --platform managed \
  --min-instances 1 --max-instances "${WORKERS_MAX_INSTANCES:-3}" \
  --cpu 1 --memory 1Gi \
  --no-cpu-throttling \
  --port 9101 \
  --set-env-vars "NODE_ENV=production,DEPLOY_ENV=${ENVIRONMENT},WORKERS_METRICS_PORT=9101,${WORKER_ENV_VARS}" \
  --set-secrets "${SHARED_SECRETS}" \
  --set-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --service-account "${RUNTIME_SERVICE_ACCOUNT}" \
  --no-allow-unauthenticated \
  --quiet

say "Deploying console"
gcloud run deploy "serviceloop-console-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
  --image "${IMAGE_BASE}/console:${TAG}" \
  --platform managed \
  --min-instances 0 --max-instances "${CONSOLE_MAX_INSTANCES:-5}" \
  --cpu 1 --memory 512Mi \
  --port 3000 \
  --set-env-vars "NODE_ENV=production,DEPLOY_ENV=${ENVIRONMENT},API_BASE_URL=${API_URL}" \
  --service-account "${RUNTIME_SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --quiet

# ---------------------------------------------------------------------- smoke
say "Smoke suite"
API_URL="$(gcloud run services describe "serviceloop-api-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" --format 'value(status.url)')"
CONSOLE_URL="$(gcloud run services describe "serviceloop-console-${ENVIRONMENT}" \
  --project "${GCP_PROJECT}" --region "${GCP_REGION}" --format 'value(status.url)')"

API_BASE_URL="${API_URL}" CONSOLE_URL="${CONSOLE_URL}" \
  "${REPO_ROOT}/infra/deploy/smoke.sh"

say "Deployed ${TAG} to ${ENVIRONMENT}"
echo "  api     ${API_URL}"
echo "  console ${CONSOLE_URL}"
echo
echo "Rollback:  infra/deploy/rollback.sh ${ENVIRONMENT}"
