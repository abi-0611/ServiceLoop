import { getEnv } from '@serviceloop/config';
import { PII_REDACT_PATHS, REDACTED } from '@serviceloop/shared';
import pino, { type Logger } from 'pino';

/** API logger with the shared PII redaction policy applied. */
export function createLogger(component = 'api'): Logger {
  const env = getEnv();
  return pino({
    name: env.SERVICE_NAME,
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME, component, demoMode: env.DEMO_MODE },
    redact: { paths: [...PII_REDACT_PATHS], censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const rootLogger = createLogger();
