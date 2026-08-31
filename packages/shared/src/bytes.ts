/**
 * Human-readable byte sizes.
 *
 * Lives in `shared` because two very different callers need the *same* words:
 * the media pipeline puts them in a rejection reason, and the i18n catalogue
 * interpolates them into the message the customer reads. A file that is "4.8 MB"
 * in the log and "5033164 bytes" in the WhatsApp reply is a support call.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
