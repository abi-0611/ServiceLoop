import {
  draftFields,
  formatPaise,
  type DraftField,
  type JobCardDraft,
  type Language,
  t,
} from '@serviceloop/shared';

/**
 * The staff confirmation surface (phase 2.6).
 *
 * A technician standing at a bench with oily hands is not going to open a
 * console. They get the extracted card back on WhatsApp as a numbered list,
 * with the fields the model is unsure about marked, and they correct it by
 * typing `2 = TN 09 BX 4432`. That is the whole interaction, and it has to work
 * with one thumb.
 *
 * Numbering is over the *displayed* lines, not over the draft's internal field
 * paths: "line 2" means the second thing they can see. Mapping that back to a
 * path is this module's job so the sender never has to know one exists.
 */

export interface DraftSummaryLine {
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly value: string;
  readonly confidence: number;
  /** True when this line is below the shop's confirmation threshold. */
  readonly uncertain: boolean;
}

export interface DraftSummary {
  readonly lines: readonly DraftSummaryLine[];
  readonly uncertainCount: number;
  /** WhatsApp-ready body, already in the thread's language. */
  readonly body: string;
}

const WARN = '⚠';

function displayValue(line: DraftField): string {
  if (line.path.endsWith('unitPricePaise')) {
    const paise = Number(line.value);
    return Number.isFinite(paise) ? formatPaise(paise) : line.value;
  }
  if (line.path === 'vehicle.odometerKm' && line.value !== '—') return `${line.value} km`;
  return line.value;
}

/**
 * Renders the numbered summary an advisor confirms.
 *
 * Uncertain fields are prefixed with ⚠ and listed first in the prompt, because
 * the point of the message is to draw a busy person's eye to the two things
 * that might be wrong, not to make them proofread fourteen that are right.
 */
export function buildDraftSummary(
  draft: JobCardDraft,
  threshold: number,
  language: Language,
): DraftSummary {
  const fields = draftFields(draft);

  const lines: DraftSummaryLine[] = fields.map((field, index) => ({
    index: index + 1,
    path: field.path,
    label: field.label,
    value: displayValue(field),
    confidence: field.confidence,
    uncertain: field.confidence < threshold,
  }));

  const uncertainCount = lines.filter((line) => line.uncertain).length;

  const rendered = lines
    .map((line) => {
      const marker = line.uncertain ? `${WARN} ` : '';
      return `${line.index}. ${marker}${line.label}: ${line.value}`;
    })
    .join('\n');

  const header = t(language, 'intake.draft_summary_header', { count: uncertainCount });
  const prompt = t(language, 'intake.confirm_prompt');

  return { lines, uncertainCount, body: `${header}\n\n${rendered}\n\n${prompt}` };
}

/* -------------------------------------------------------------------------- *
 * Quick corrections
 * -------------------------------------------------------------------------- */

export interface QuickCorrection {
  readonly lineIndex: number;
  readonly value: string;
}

/**
 * Parses `2 = TN 09 BX 4432` and the shapes people actually type instead.
 *
 * Accepted separators are `=`, `:` and `-`, because all three get typed and a
 * rejected correction means a technician retyping it. A leading `#` is
 * tolerated for the same reason. Multiple corrections may arrive in one
 * message, one per line — which is what happens when someone fixes two fields
 * at once.
 *
 * Deliberately strict about the *left* side: it must be a bare number, so
 * "3 pads at 450" is read as conversation rather than as a correction to line 3.
 */
const CORRECTION_LINE = /^\s*#?\s*(\d{1,3})\s*[=:–—-]\s*(.+?)\s*$/;

export function parseQuickCorrection(text: string): QuickCorrection[] {
  const corrections: QuickCorrection[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const match = CORRECTION_LINE.exec(rawLine);
    if (match === null) continue;

    const lineIndex = Number(match[1]);
    const value = (match[2] ?? '').trim();
    if (!Number.isInteger(lineIndex) || lineIndex < 1 || value.length === 0) continue;

    corrections.push({ lineIndex, value });
  }

  return corrections;
}

/** Maps a typed line number back to the draft path it addresses. */
export function pathForLine(summary: DraftSummary, lineIndex: number): string | null {
  return summary.lines.find((line) => line.index === lineIndex)?.path ?? null;
}

/** Ids for the interactive buttons attached to a draft summary. */
export const DRAFT_ACTION_IDS = {
  confirm: (draftId: string) => `intake:confirm:${draftId}`,
  discard: (draftId: string) => `intake:discard:${draftId}`,
  edit: (draftId: string) => `intake:edit:${draftId}`,
} as const;

export interface ParsedDraftAction {
  readonly action: 'confirm' | 'discard' | 'edit';
  readonly draftId: string;
}

export function parseDraftAction(replyId: string): ParsedDraftAction | null {
  const match = /^intake:(confirm|discard|edit):(.+)$/.exec(replyId);
  if (match === null) return null;
  return {
    action: match[1] as ParsedDraftAction['action'],
    draftId: match[2] as string,
  };
}
