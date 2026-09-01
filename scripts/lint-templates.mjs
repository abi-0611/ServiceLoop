#!/usr/bin/env node
/**
 * Template lint, as a CI gate (phase 7.3).
 *
 *   node scripts/lint-templates.mjs
 *
 * A thin wrapper around `lintTemplates()` in `@serviceloop/shared`, which is
 * the same function the console's template-ops screen and the unit tests call.
 * One implementation, three consumers: a CI step with its own copy of the rules
 * would drift from the screen an operator looks at, and then the screen would
 * be the one that was wrong.
 *
 * Fails the build on any finding. The three it exists to catch all surface in
 * front of a customer otherwise:
 *
 *   - a Tamil variant taking different variables from its English original,
 *     so the Tamil send throws at substitution time;
 *   - a customer-facing template that exists only in English;
 *   - a template name Meta would reject on submission.
 */

// A relative path into the built package rather than a bare specifier: the
// repository root is not a workspace member, so `@serviceloop/shared` does not
// resolve from `scripts/`. Requiring the build first is correct anyway — the
// lint must run against what will ship, not against the source.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lintTemplates, formatLintFindings, TEMPLATE_MANIFEST } = require(
  '../packages/shared/dist/index.js',
);

const findings = lintTemplates();

if (findings.length > 0) {
  console.error(`Template lint failed with ${findings.length} finding(s):\n`);
  console.error(formatLintFindings(findings));
  console.error('\nFix the manifest or the catalogue. Both are code; neither is a runtime detail.');
  process.exit(1);
}

const customerFacing = TEMPLATE_MANIFEST.filter((spec) => spec.customerFacing).length;
console.log(
  `Template lint clean: ${TEMPLATE_MANIFEST.length} template(s), ` +
    `${customerFacing} customer-facing, all three languages consistent.`,
);
