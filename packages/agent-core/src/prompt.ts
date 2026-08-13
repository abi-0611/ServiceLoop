import { createHash } from 'node:crypto';
import { canonicalJson } from '@serviceloop/shared';

/**
 * Prompt assembly and hashing.
 *
 * Master §6 requires every agent step — prompt hash included — to land in the
 * audit log. Hashing the *assembled* prompt (not the template) means an audit
 * can prove exactly which instructions produced a given tool call, without
 * storing customer data in the audit row.
 */

export interface PromptSection {
  readonly name: string;
  readonly content: string;
}

export interface AssembledPrompt {
  readonly text: string;
  readonly hash: string;
  readonly sections: readonly string[];
}

export function assemblePrompt(sections: readonly PromptSection[]): AssembledPrompt {
  const text = sections
    .map((section) => `## ${section.name}\n${section.content.trim()}`)
    .join('\n\n');

  return {
    text,
    hash: hashPrompt(sections),
    sections: sections.map((section) => section.name),
  };
}

export function hashPrompt(sections: readonly PromptSection[]): string {
  return createHash('sha256')
    .update(canonicalJson(sections.map((section) => [section.name, section.content])))
    .digest('hex');
}
