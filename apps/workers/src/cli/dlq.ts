import { createInterface } from 'node:readline/promises';
import { getEnv } from '@serviceloop/config';
import { DEAD_LETTER_QUEUE, queueForEventType, type EventType } from '@serviceloop/shared';
import { Queue } from 'bullmq';
import { connectionFor, createRedis } from '../queues';

/**
 * Dead-letter inspection and replay (phase 7.5).
 *
 *   pnpm dlq:list                      # what is in there, and why
 *   pnpm dlq:replay --id <jobId>       # one job, back onto its queue
 *   pnpm dlq:replay --all --type X     # every job of one event type
 *   pnpm dlq:drop --id <jobId>         # give up on one, with a reason
 *
 * **Replay asks for confirmation, and that is not politeness.** A dead-letter
 * queue is where poison messages end up, and a poison message replayed is the
 * same failure again — but now with the original having been retried five
 * times first. Worse, some handlers are only *mostly* idempotent: replaying a
 * `message.sent` after its cost row was already written double-counts, and
 * replaying an event whose downstream state has since changed can produce a
 * message a customer should no longer receive.
 *
 * So the operator types the count. Not `y`, not `--yes` — the number of jobs
 * they are about to replay, which cannot be muscle memory and cannot be a
 * shell alias.
 */

interface DeadLetterPayload {
  readonly queue?: string;
  readonly envelope?: { readonly id?: string; readonly type?: string; readonly shopId?: string };
  readonly error?: string;
  readonly failedAt?: string;
}

async function main(): Promise<void> {
  const env = getEnv();
  const command = process.argv[2] ?? 'list';
  const redis = createRedis(env.REDIS_URL);
  const dlq = new Queue(DEAD_LETTER_QUEUE, { connection: connectionFor(redis) });

  try {
    switch (command) {
      case 'list':
        await list(dlq);
        break;
      case 'replay':
        await replay(dlq, redis);
        break;
      case 'drop':
        await drop(dlq);
        break;
      default:
        console.error(`Unknown command "${command}". Use list, replay or drop.`);
        process.exit(2);
    }
  } finally {
    await dlq.close();
    await redis.quit();
  }
}

async function list(dlq: Queue): Promise<void> {
  const jobs = await dlq.getJobs(['waiting', 'delayed', 'failed', 'completed'], 0, 200);
  if (jobs.length === 0) {
    console.log('The dead-letter queue is empty.');
    return;
  }

  // Grouped by event type and error, because that is the shape of the actual
  // question: a DLQ with 200 rows is almost always two problems, and a flat
  // list of 200 lines hides that.
  const groups = new Map<string, { count: number; example: string; jobIds: string[] }>();
  for (const job of jobs) {
    const payload = job.data as DeadLetterPayload;
    const key = `${payload.envelope?.type ?? 'unknown'} :: ${firstLine(payload.error)}`;
    const group = groups.get(key) ?? { count: 0, example: job.id ?? '', jobIds: [] };
    group.count += 1;
    group.jobIds.push(job.id ?? '');
    groups.set(key, group);
  }

  console.log(`${jobs.length} job(s) in the dead-letter queue, in ${groups.size} group(s):\n`);
  for (const [key, group] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const [type, error] = key.split(' :: ');
    console.log(`  ${String(group.count).padStart(4)}  ${type}`);
    console.log(`        ${error}`);
    console.log(`        e.g. job ${group.example}`);
    console.log();
  }
  console.log('Replay:  pnpm dlq:replay --all --type <event.type>');
  console.log('  or:    pnpm dlq:replay --id <jobId>');
}

async function replay(dlq: Queue, redis: ReturnType<typeof createRedis>): Promise<void> {
  const id = argValue('--id');
  const type = argValue('--type');
  const all = process.argv.includes('--all');

  if (id === null && !all) {
    console.error('Specify --id <jobId>, or --all with an optional --type.');
    process.exit(2);
  }

  const jobs = await dlq.getJobs(['waiting', 'delayed', 'failed', 'completed'], 0, 1000);
  const selected = jobs.filter((job) => {
    const payload = job.data as DeadLetterPayload;
    if (id !== null) return job.id === id;
    if (type !== null) return payload.envelope?.type === type;
    return true;
  });

  if (selected.length === 0) {
    console.log('Nothing matched. Run `pnpm dlq:list` to see what is there.');
    return;
  }

  console.log(`About to replay ${selected.length} job(s):`);
  for (const job of selected.slice(0, 10)) {
    const payload = job.data as DeadLetterPayload;
    console.log(`  ${job.id}  ${payload.envelope?.type}  shop ${payload.envelope?.shopId}`);
  }
  if (selected.length > 10) console.log(`  … and ${selected.length - 10} more`);

  console.log();
  console.log('Replaying re-runs a handler that already failed. Some are only mostly');
  console.log('idempotent — read docs/runbooks/alerts.md#dead-letter-growth first.');
  console.log();

  // The count, typed. Not `y`: a confirmation that can be answered without
  // reading is a confirmation that is always answered.
  const answer = await ask(`Type the number of jobs to replay (${selected.length}) to confirm: `);
  if (answer.trim() !== String(selected.length)) {
    console.log('Cancelled.');
    return;
  }

  let replayed = 0;
  for (const job of selected) {
    const payload = job.data as DeadLetterPayload;
    const envelope = payload.envelope;
    if (envelope?.type === undefined) {
      console.error(`  skipped ${job.id}: no event type on the payload`);
      continue;
    }

    // Routed by the same static table the dispatcher uses, not by the queue
    // name recorded on the dead-letter payload. A job that was dead-lettered
    // before a routing change must land where that event type lives *now*.
    const queueName = queueForEventType(envelope.type as EventType);
    const target = new Queue(queueName, { connection: connectionFor(redis) });
    await target.add(envelope.type, envelope, { jobId: `replay:${envelope.id}` });
    await target.close();

    await job.remove();
    replayed += 1;
  }

  console.log(`Replayed ${replayed} job(s).`);
}

async function drop(dlq: Queue): Promise<void> {
  const id = argValue('--id');
  if (id === null) {
    console.error('Specify --id <jobId>.');
    process.exit(2);
  }

  const job = await dlq.getJob(id);
  if (job === undefined) {
    console.error(`No job ${id} in the dead-letter queue.`);
    process.exit(1);
  }

  const payload = job.data as DeadLetterPayload;
  console.log(`Dropping ${id}: ${payload.envelope?.type} (shop ${payload.envelope?.shopId})`);
  console.log(`Error was: ${firstLine(payload.error)}`);
  console.log();
  console.log('This discards the event permanently. Whatever it was going to do');
  console.log('will not happen, and nothing will retry it.');

  const reason = await ask('Reason for dropping it (recorded in this session only): ');
  if (reason.trim().length < 10) {
    console.log('Cancelled: a reason under ten characters is not a reason.');
    return;
  }

  await job.remove();
  console.log(`Dropped ${id}. Note the reason in the incident log: ${reason.trim()}`);
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function firstLine(text: string | undefined): string {
  return (text ?? 'no error recorded').split('\n')[0]?.slice(0, 120) ?? '';
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error('[dlq] failed');
  console.error(error);
  process.exit(1);
});
