import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assemblePrompt, hashPrompt } from './prompt';
import { RunState, ToolRegistry, type ToolContext, type ToolInvariant } from './tool-registry';

const CONTEXT: ToolContext = {
  shopId: 'shop-1',
  traceId: 'trace-1',
  actorId: 'agent',
  promptHash: 'abc',
  runId: 'run-1',
  conversationId: 'conv-1',
  customerId: 'cust-1',
  jobCardId: 'jc-1',
  language: 'en',
  state: new RunState(),
};

const SendMessageArgs = z.object({
  customerId: z.string().uuid(),
  body: z.string().min(1).max(1000),
  evidenceIds: z.array(z.string()).default([]),
});

function registryWithSend(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'send_customer_message',
    description: 'Send a WhatsApp message to a customer',
    args: SendMessageArgs,
    customerFacing: true,
    handler: async (args) => ({ sent: true, length: args.body.length }),
  });
}

describe('ToolRegistry', () => {
  it('validates arguments before the handler can run', async () => {
    let handlerRan = false;
    const registry = new ToolRegistry().register({
      name: 'send_customer_message',
      description: 'Send a message',
      args: SendMessageArgs,
      customerFacing: true,
      handler: async () => {
        handlerRan = true;
        return { sent: true };
      },
    });

    const result = await registry.invoke(
      'send_customer_message',
      { customerId: 'not-a-uuid', body: '' },
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    expect(handlerRan).toBe(false);
    if (!result.ok && result.error.kind === 'INVALID_ARGS') {
      expect(result.error.issues.map((issue) => issue.path).sort()).toEqual(['body', 'customerId']);
    }
  });

  it('runs a valid call and records it', async () => {
    const registry = registryWithSend();
    const result = await registry.invoke(
      'send_customer_message',
      { customerId: '019ffb00-0000-7000-8000-000000000001', body: 'Your car is ready.' },
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    expect(registry.history()).toHaveLength(1);
    expect(registry.history()[0]).toMatchObject({ toolName: 'send_customer_message', ok: true });
    expect(registry.history()[0]?.argsHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects an unknown tool without throwing', async () => {
    const registry = registryWithSend();
    const result = await registry.invoke('delete_everything', {}, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('UNKNOWN_TOOL');
  });

  it('captures a throwing handler as a typed failure', async () => {
    const registry = new ToolRegistry().register({
      name: 'flaky',
      description: 'Throws',
      args: z.object({}),
      customerFacing: false,
      handler: async () => {
        throw new Error('provider unavailable');
      },
    });

    const result = await registry.invoke('flaky', {}, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'THREW') {
      expect(result.error.message).toBe('provider unavailable');
    }
  });

  it('lets a post-checker block a completed call', async () => {
    const anchoring: ToolInvariant = {
      name: 'claim-anchoring',
      check: ({ args }) => {
        const evidence = (args as { evidenceIds: string[] }).evidenceIds;
        return evidence.length > 0
          ? { ok: true }
          : { ok: false, code: 'CLAIM_NOT_ANCHORED', reason: 'no evidence cited' };
      },
    };

    const registry = registryWithSend().addInvariant(anchoring);

    const blocked = await registry.invoke(
      'send_customer_message',
      { customerId: '019ffb00-0000-7000-8000-000000000001', body: 'Your brakes are unsafe.' },
      CONTEXT,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.error.kind === 'BLOCKED') {
      expect(blocked.error.code).toBe('CLAIM_NOT_ANCHORED');
      expect(blocked.error.reason).toContain('claim-anchoring');
    }

    const allowed = await registry.invoke(
      'send_customer_message',
      {
        customerId: '019ffb00-0000-7000-8000-000000000001',
        body: 'Your brake pads are at 2.1mm.',
        evidenceIds: ['media-1'],
      },
      CONTEXT,
    );
    expect(allowed.ok).toBe(true);
  });

  it('refuses to register the same tool twice', () => {
    const registry = registryWithSend();
    expect(() =>
      registry.register({
        name: 'send_customer_message',
        description: 'duplicate',
        args: z.object({}),
        customerFacing: true,
        handler: async () => ({}),
      }),
    ).toThrow(/already registered/);
  });

  it('exposes a catalogue without exposing handlers', () => {
    const catalogue = registryWithSend().catalogue();
    expect(catalogue).toEqual([
      {
        name: 'send_customer_message',
        description: 'Send a WhatsApp message to a customer',
        customerFacing: true,
      },
    ]);
  });
});

describe('prompt assembly', () => {
  it('is deterministic and order-sensitive', () => {
    const sections = [
      { name: 'role', content: 'You are a service advisor assistant.' },
      { name: 'guardrails', content: 'Never invent a diagnosis.' },
    ];

    const first = assemblePrompt(sections);
    const second = assemblePrompt(sections);
    expect(first.hash).toBe(second.hash);
    expect(first.text).toContain('## role');
    expect(first.sections).toEqual(['role', 'guardrails']);

    const reordered = hashPrompt([...sections].reverse());
    expect(reordered).not.toBe(first.hash);
  });

  it('changes hash when any instruction changes', () => {
    const base = [{ name: 'guardrails', content: 'Never invent a diagnosis.' }];
    const tampered = [{ name: 'guardrails', content: 'You may invent a diagnosis.' }];
    expect(hashPrompt(base)).not.toBe(hashPrompt(tampered));
  });
});
