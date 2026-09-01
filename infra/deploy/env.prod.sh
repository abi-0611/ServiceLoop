# Production deployment parameters (phase 7.7).
#
# Read the adapter allow-list at the foot of this file before changing anything
# here. It is the last line of defence between a deploy-script typo and a
# customer receiving a message from a sandbox — or worse, not receiving one.

export GCP_PROJECT="serviceloop-prod"
export GCP_REGION="asia-south1"
export ARTIFACT_REPO="serviceloop"

export CLOUD_SQL_INSTANCE="serviceloop-prod:asia-south1:serviceloop-pg"
export VPC_CONNECTOR="serviceloop-prod-connector"
export RUNTIME_SERVICE_ACCOUNT="serviceloop-run@serviceloop-prod.iam.gserviceaccount.com"

export API_MAX_INSTANCES=20
export WORKERS_MAX_INSTANCES=4
export CONSOLE_MAX_INSTANCES=10

export SHARED_SECRETS="\
DATABASE_URL=serviceloop-database-url-prod:latest,\
REDIS_URL=serviceloop-redis-url-prod:latest,\
JWT_SECRET=serviceloop-jwt-secret-prod:latest,\
PII_ENCRYPTION_KEY=serviceloop-pii-key-prod:latest,\
PII_KEY_RING=serviceloop-pii-key-ring-prod:latest,\
BLIND_INDEX_KEY=serviceloop-blind-index-key-prod:latest,\
GATE_PASS_SECRET=serviceloop-gate-pass-secret-prod:latest,\
ANTHROPIC_API_KEY=serviceloop-anthropic-key-prod:latest,\
WHATSAPP_ACCESS_TOKEN=serviceloop-whatsapp-token-prod:latest,\
WHATSAPP_APP_SECRET=serviceloop-whatsapp-app-secret-prod:latest,\
WHATSAPP_VERIFY_TOKEN=serviceloop-whatsapp-verify-token-prod:latest,\
SARVAM_API_KEY=serviceloop-sarvam-key-prod:latest,\
GOOGLE_SPEECH_ACCESS_TOKEN=serviceloop-google-speech-token-prod:latest,\
EXOTEL_API_KEY=serviceloop-exotel-key-prod:latest,\
EXOTEL_API_TOKEN=serviceloop-exotel-token-prod:latest,\
TELEPHONY_WEBHOOK_SECRET=serviceloop-telephony-webhook-secret-prod:latest,\
RAZORPAY_KEY_SECRET=serviceloop-razorpay-secret-prod:latest,\
RAZORPAY_WEBHOOK_SECRET=serviceloop-razorpay-webhook-secret-prod:latest,\
SMS_PROVIDER_API_KEY=serviceloop-sms-key-prod:latest"

# ---------------------------------------------------------------------------
# The production adapter allow-list.
#
# `ADAPTER_ALLOWLIST` names, port by port, exactly which adapter production is
# permitted to boot with. `logBootBanner` compares it against what
# `selectAdapters` actually resolved and refuses to start on any disagreement —
# so this string is not documentation, it is an assertion the process makes
# about itself before it accepts a request.
#
# It complements the `NODE_ENV=production` refusals in `env.ts` and fails in the
# opposite direction. Those say "not the sandbox"; this says "exactly this one".
# The difference matters the day somebody adds a third WhatsApp adapter and a
# typo in a deploy script selects it: every value involved is plausible, the
# service starts, and messages go somewhere nobody intended.
# ---------------------------------------------------------------------------
export PROD_ADAPTER_ALLOWLIST="\
storage:S3Storage,\
notifier:SmsNotifier,\
llm:AnthropicLlmAdapter,\
ocr:VisionLlmOcrAdapter,\
whatsapp:MetaCloudWhatsAppAdapter,\
sms:DltSmsAdapter,\
antivirus:ClamAvScanner,\
speech:FailoverSpeech,\
speech-stream:SarvamStreamingAdapter,\
telephony:ExotelTelephonyAdapter,\
payments:RazorpayPaymentsAdapter"

export API_ENV_VARS="\
DEMO_MODE=false,\
LOG_LEVEL=info,\
WHATSAPP_DRIVER=meta,\
WHATSAPP_PHONE_NUMBER_ID=000000000000000,\
LLM_DRIVER=anthropic,\
SPEECH_DRIVER=sarvam,\
SPEECH_STREAM_DRIVER=sarvam,\
TELEPHONY_DRIVER=exotel,\
PAYMENTS_DRIVER=razorpay,\
NOTIFIER_DRIVER=sms,\
SMS_DRIVER=dlt,\
STORAGE_DRIVER=s3,\
ANTIVIRUS_DRIVER=clamav,\
ANTIVIRUS_FAIL_CLOSED=false,\
SSRF_ALLOW_PRIVATE=false,\
RATE_LIMIT_ENABLED=true,\
OTEL_ENABLED=true,\
OTEL_TRACES_SAMPLER_RATIO=0.2,\
ADAPTER_ALLOWLIST=${PROD_ADAPTER_ALLOWLIST},\
CORS_ALLOWED_ORIGINS=https://console.serviceloop.example"

export WORKER_ENV_VARS="${API_ENV_VARS}"

export API_URL="https://api.serviceloop.example"
export CONSOLE_URL="https://console.serviceloop.example"
