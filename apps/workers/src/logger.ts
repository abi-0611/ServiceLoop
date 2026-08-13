import { getEnv } from '@serviceloop/config';
import { PII_REDACT_PATHS, REDACTED } from '@serviceloop/shared';
import pino, { type Logger } from 'pino';

/** Worker logger with the shared PII redaction policy applied. */
export function createLogger(name: string): Logger {
  const env = getEnv();
  return pino({
    name,
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME, component: name, demoMode: env.DEMO_MODE },
    redact: { paths: [...PII_REDACT_PATHS], censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
