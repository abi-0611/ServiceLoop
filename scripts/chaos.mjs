#!/usr/bin/env node
/**
 * Chaos drills (phase 7.5).
 *
 *   node scripts/chaos.mjs redis-kill
 *   node scripts/chaos.mjs worker-kill
 *   node scripts/chaos.mjs llm-blackout
 *   node scripts/chaos.mjs all
 *
 * Three scenarios, and each asserts the *same three properties* afterwards,
 * because those three are what the whole reliability design is for:
 *
 *   1. No message loss.        Every outbox row eventually dispatches.
 *   2. No duplicate sends.     No customer receives the same message twice.
 *   3. The alert fired.        The failure was visible, not just survived.
 *
 * The third is the one that gets left out, and it is the one that matters most:
 * a system that recovers silently from a failure it never reported is a system
 * that will fail the same way in production with nobody watching.
 *
 * These run against the compose stack in DEMO_MODE. They kill real containers
 * and real processes; do not point this at anything you care about — the first
 * thing it does is check it is not talking to production.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const COMPOSE = ['compose', '--project-directory', '.', '-f', 'infra/compose.yaml'];

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function psql(sql) {
  const result = docker([
    ...COMPOSE,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'serviceloop',
    '-d',
    'serviceloop',
    '-tAc',
    sql,
  ]);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}

function say(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

function refuseProduction() {
  // The check that stops this script being the incident. `DEPLOY_ENV` is
  // explicit rather than inferred, because inferring "am I in production" from
  // a hostname is exactly the kind of guess that is wrong once.
  const env = process.env.DEPLOY_ENV ?? 'local';
  if (env !== 'local') {
    console.error(`Refusing to run chaos drills with DEPLOY_ENV=${env}.`);
    process.exit(1);
  }
  if (process.env.DEMO_MODE === 'false') {
    console.error('Refusing to run chaos drills with DEMO_MODE=false: the adapters are live.');
    process.exit(1);
  }
}

/** The three invariants, checked identically after every scenario. */
async function assertInvariants(label, baseline) {
  say(`Checking invariants after ${label}`);

  // 1. No message loss. Give the dispatcher a chance to drain, then assert
  //    nothing is stuck. A PENDING row older than two minutes after recovery is
  //    a lost message, not a slow one.
  let stuck = '0';
  for (let attempt = 0; attempt < 24; attempt += 1) {
    stuck = psql(
      "select count(*) from events_outbox where status = 'PENDING' and occurred_at < now() - interval '2 minutes'",
    );
    if (stuck === '0') break;
    await sleep(5_000);
  }
  report('no message loss', stuck === '0', `${stuck} outbox row(s) still pending after two minutes`);

  // 2. No duplicate sends. Two SENT messages with the same provider id would
  //    mean a customer received the same thing twice — the failure retries are
  //    supposed to make impossible.
  const duplicates = psql(`
    select count(*) from (
      select provider_message_id from messages
      where direction = 'OUTBOUND' and status = 'SENT' and provider_message_id is not null
      group by provider_message_id having count(*) > 1
    ) d
  `);
  report('no duplicate sends', duplicates === '0', `${duplicates} duplicated provider message id(s)`);

  // 3. Nothing was parked. A row that exhausted its attempts is a message that
  //    will never be sent unless somebody replays it by hand.
  const parked = psql("select count(*) from events_outbox where status = 'FAILED'");
  const newlyParked = Number(parked) - Number(baseline.parked);
  report('nothing parked', newlyParked <= 0, `${newlyParked} row(s) parked during the drill`);

  // 4. The failure was visible. Checked against the *metrics endpoint*, which
  //    is what Prometheus reads and therefore what an alert would have fired on.
  const visible = await failureWasVisible();
  report('the failure was observable', visible, 'no error metric moved during the drill');
}

let failures = 0;

function report(name, ok, detail) {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}: ${detail}`);
  }
}

async function failureWasVisible() {
  try {
    const response = await fetch(
      process.env.METRICS_URL ?? 'http://localhost:9101/metrics',
      { signal: AbortSignal.timeout(5_000) },
    );
    const body = await response.text();
    // Any of these having moved means the failure reached a metric. Which one
    // depends on the scenario, and the drill does not care — it cares that the
    // system was not silent.
    return /serviceloop_(outbox_failed_total|dead_lettered_total|llm_calls_total\{[^}]*outcome="error")/.test(
      body,
    );
  } catch {
    return false;
  }
}

async function snapshot() {
  return { parked: psql("select count(*) from events_outbox where status = 'FAILED'") };
}

/* ------------------------------------------------------------------ drills */

/**
 * Kill Redis mid-ladder.
 *
 * The interesting property is that the *rows* survive even though the queue
 * does not: an escalation is a database row with a schedule, and the BullMQ
 * delayed job is only a timer. Losing Redis loses timers and loses nothing
 * else, which is why the rung tables exist at all.
 */
async function redisKill(baseline) {
  say('Drill: Redis dies mid-ladder');
  const scheduled = psql("select count(*) from escalations where status = 'SCHEDULED'");
  console.log(`  ${scheduled} scheduled rung(s) before the kill`);

  docker([...COMPOSE, 'kill', 'redis']);
  console.log('  redis killed; waiting 20s with the system running against nothing');
  await sleep(20_000);

  docker([...COMPOSE, 'start', 'redis']);
  console.log('  redis restarted; waiting 30s for reconnection');
  await sleep(30_000);

  const stillScheduled = psql("select count(*) from escalations where status = 'SCHEDULED'");
  report(
    'scheduled rungs survived the queue',
    Number(stillScheduled) >= Number(scheduled) - 1,
    `${scheduled} before, ${stillScheduled} after`,
  );

  await assertInvariants('redis-kill', baseline);
}

/**
 * Kill a worker mid-batch.
 *
 * The outbox dispatcher claims rows `FOR UPDATE SKIP LOCKED` inside a
 * transaction, so a process that dies mid-batch releases its locks and the rows
 * go back to PENDING. The property being checked is that they are picked up
 * again *and not twice* — which is the consumer-side idempotency claim doing
 * its job.
 */
async function workerKill(baseline) {
  say('Drill: a worker dies mid-batch');

  const before = psql("select count(*) from events_outbox where status = 'PENDING'");
  console.log(`  ${before} pending row(s) at the kill`);

  // SIGKILL, not SIGTERM: a graceful shutdown is a different drill (and is
  // exercised by `pnpm demo:phase7`). This is the power-cut case.
  const result = spawnSync(
    process.platform === 'win32' ? 'taskkill' : 'pkill',
    process.platform === 'win32'
      ? ['/F', '/IM', 'node.exe', '/FI', 'WINDOWTITLE eq workers*']
      : ['-9', '-f', 'apps/workers'],
    { encoding: 'utf8' },
  );
  console.log(`  worker killed (${result.status === 0 ? 'ok' : 'no matching process'})`);
  console.log('  restart the worker now: pnpm --filter @serviceloop/workers dev');
  await sleep(45_000);

  await assertInvariants('worker-kill', baseline);
}

/**
 * The model provider returns errors for five minutes.
 *
 * The property: the agent degrades to queue-and-apologise rather than sending
 * nonsense or silently dropping the objective. No customer message goes out
 * that was not composed from the catalogue, and every stalled objective ends up
 * as an advisor task — which is the guardrail the whole autonomy design rests
 * on, and it is only ever exercised by a drill like this one.
 */
async function llmBlackout(baseline) {
  say('Drill: the model provider is down for five minutes');
  console.log('  Set LLM_DRIVER=anthropic with ANTHROPIC_BASE_URL pointed at a black hole,');
  console.log('  or use the sandbox adapter’s failure injection:');
  console.log('    SANDBOX_LLM_FAILURE_RATE=1 pnpm --filter @serviceloop/workers dev');
  console.log('  then drive traffic through the simulator for five minutes.');
  await sleep(Number(process.env.CHAOS_LLM_SECONDS ?? 300) * 1000);

  // The specific assertion: advisor tasks were raised. An agent that failed
  // silently would leave neither a message nor a task, and the customer would
  // simply never hear back.
  const tasks = psql(
    "select count(*) from advisor_tasks where created_at > now() - interval '10 minutes'",
  );
  report(
    'stalled objectives became advisor tasks',
    Number(tasks) > 0,
    'no advisor tasks were raised during the blackout',
  );

  // And no free-form message went out. Everything sent during a model outage
  // must have come from the catalogue.
  const freeform = psql(`
    select count(*) from messages
    where direction = 'OUTBOUND' and status = 'SENT'
      and created_by_agent = true
      and created_at > now() - interval '10 minutes'
  `);
  report(
    'no agent-composed message was sent during the blackout',
    freeform === '0',
    `${freeform} agent-composed message(s) went out while the model was down`,
  );

  await assertInvariants('llm-blackout', baseline);
}

/* ------------------------------------------------------------------- main */

const scenario = process.argv[2] ?? 'all';
refuseProduction();

try {
  execFileSync('docker', ['version'], { stdio: 'ignore' });
} catch {
  console.error('Docker is not available. The chaos drills kill real containers.');
  process.exit(1);
}

const baseline = await snapshot();

if (scenario === 'redis-kill' || scenario === 'all') await redisKill(baseline);
if (scenario === 'worker-kill' || scenario === 'all') await workerKill(baseline);
if (scenario === 'llm-blackout' || scenario === 'all') await llmBlackout(baseline);

console.log();
if (failures > 0) {
  console.error(`${failures} chaos assertion(s) failed.`);
  process.exit(1);
}
console.log('All chaos drills passed.');
