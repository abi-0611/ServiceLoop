# Staging deployment parameters (phase 7.7).
#
# Committed, and containing no secrets — every value here is a resource name.
# The secrets themselves live in Secret Manager and are named below; nothing in
# this repository ever holds one, which is what the gitleaks CI step exists to
# keep true.
#
# Copy this file, change the project, and you have a second staging.

export GCP_PROJECT="serviceloop-staging"
export GCP_REGION="asia-south1"          # Mumbai. The customers are in India.
export ARTIFACT_REPO="serviceloop"

export CLOUD_SQL_INSTANCE="serviceloop-staging:asia-south1:serviceloop-pg"
export VPC_CONNECTOR="serviceloop-staging-connector"
export RUNTIME_SERVICE_ACCOUNT="serviceloop-run@serviceloop-staging.iam.gserviceaccount.com"

export API_MAX_INSTANCES=4
export WORKERS_MAX_INSTANCES=2
export CONSOLE_MAX_INSTANCES=2

# Every secret, by Secret Manager name. `--set-secrets` mounts them as
# environment variables at start-up, so the process reads them through the same
# `getEnv()` gate as everything else and no code knows they came from a vault.
export SHARED_SECRETS="\
DATABASE_URL=serviceloop-database-url-staging:latest,\
REDIS_URL=serviceloop-redis-url-staging:latest,\
JWT_SECRET=serviceloop-jwt-secret-staging:latest,\
PII_ENCRYPTION_KEY=serviceloop-pii-key-staging:latest,\
PII_KEY_RING=serviceloop-pii-key-ring-staging:latest,\
BLIND_INDEX_KEY=serviceloop-blind-index-key-staging:latest,\
GATE_PASS_SECRET=serviceloop-gate-pass-secret-staging:latest,\
ANTHROPIC_API_KEY=serviceloop-anthropic-key-staging:latest,\
WHATSAPP_ACCESS_TOKEN=serviceloop-whatsapp-token-staging:latest,\
WHATSAPP_APP_SECRET=serviceloop-whatsapp-app-secret-staging:latest,\
WHATSAPP_VERIFY_TOKEN=serviceloop-whatsapp-verify-token-staging:latest,\
SARVAM_API_KEY=serviceloop-sarvam-key-staging:latest,\
RAZORPAY_KEY_SECRET=serviceloop-razorpay-secret-staging:latest,\
RAZORPAY_WEBHOOK_SECRET=serviceloop-razorpay-webhook-secret-staging:latest,\
SMS_PROVIDER_API_KEY=serviceloop-sms-key-staging:latest"

# ---------------------------------------------------------------------------
# The staging adapter matrix.
#
# Staging runs *mixed*, and that is the whole reason it exists as a separate
# environment rather than a second production. WhatsApp is live against a test
# WABA and a test number, because template approval and the 24-hour window
# cannot be simulated and are where the surprises are. Payments and telephony
# stay on the mock and the loopback, because a staging bug that charges a card
# or rings a stranger is a real-world consequence for a rehearsal.
#
# `DEMO_MODE=false` is what makes the mix possible: DEMO_MODE forces *every*
# adapter to its sandbox, which is right for a laptop and useless for a
# rehearsal of the live WhatsApp path.
#
# `DEPLOY_ENV=staging` is what keeps the allow-list off — production names every
# live adapter explicitly and refuses to boot otherwise, and a mixed matrix
# could not satisfy that.
# ---------------------------------------------------------------------------
export API_ENV_VARS="\
DEMO_MODE=false,\
LOG_LEVEL=info,\
WHATSAPP_DRIVER=meta,\
WHATSAPP_PHONE_NUMBER_ID=000000000000000,\
LLM_DRIVER=anthropic,\
SPEECH_DRIVER=mock,\
SPEECH_STREAM_DRIVER=mock,\
TELEPHONY_DRIVER=loopback,\
PAYMENTS_DRIVER=mock,\
NOTIFIER_DRIVER=log,\
SMS_DRIVER=sandbox,\
STORAGE_DRIVER=s3,\
ANTIVIRUS_DRIVER=none,\
OTEL_ENABLED=true,\
OTEL_TRACES_SAMPLER_RATIO=1,\
CORS_ALLOWED_ORIGINS=https://console-staging.serviceloop.example"

export WORKER_ENV_VARS="${API_ENV_VARS}"

export API_URL="https://api-staging.serviceloop.example"
export CONSOLE_URL="https://console-staging.serviceloop.example"
