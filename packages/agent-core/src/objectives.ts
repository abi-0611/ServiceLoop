import type { AgentObjective } from '@serviceloop/shared';

/**
 * Objective specs.
 *
 * An objective is a goal *with a termination condition the runtime can observe*.
 * `metWhen` names the tool whose success ends the run — the model does not get
 * to declare victory, because a model that says "objective met" after sending
 * nothing is the most common way an agent loop silently does nothing at all.
 */

export interface ObjectiveSpec {
  readonly key: AgentObjective;
  readonly title: string;
  /** Injected into the prompt: what success looks like from here. */
  readonly instructions: string;
  /**
   * Tools whose successful invocation completes the objective. Any one of them
   * ends the run with `objective_met`.
   */
  readonly metWhen: readonly string[];
  /** Tools this objective may use. A narrower set is a safer objective. */
  readonly tools: readonly string[];
}

const SHARED_TOOLS = [
  'get_job_card',
  'get_customer_context',
  'compose_customer_message',
  'send_customer_message',
  'handoff_to_human',
  'log_note',
] as const;

export const OBJECTIVE_SPECS: Readonly<Record<AgentObjective, ObjectiveSpec>> = {
  request_approval: {
    key: 'request_approval',
    title: 'Put the evidence bundle to the customer and get a decision',
    instructions: `A technician has found work that needs the customer's approval, and an
evidence bundle has been prepared: the photos, the itemised lines, and a
plain-language explanation whose every sentence cites a source.

Your job is to put it to them clearly and let them decide. Read the card, then
call create_approval_request with the work item ids and the ladder reference.
That tool composes and sends the interactive message with the three buttons —
you do not compose it yourself, because the buttons and the itemisation must be
identical on every request the shop ever sends.

Do not chase. The escalation ladder does that on its own schedule.`,
    metWhen: ['create_approval_request'],
    tools: [...SHARED_TOOLS, 'create_approval_request', 'schedule_followup'],
  },

  resolve_partial_approval: {
    key: 'resolve_partial_approval',
    title: 'Answer the objection and get to a decision',
    instructions: `The customer has replied to an approval request with something other than a
plain yes. Work out what they actually mean and respond to that:

  - PRICE ("too much", "any discount?", "kammi pannunga"). Try adjust_offer
    within the shop's limits. If it refuses, relay the refusal honestly and
    offer to check with the owner. Never imply a discount you were refused.
  - DEFER ("next month", "after salary"). Accept it without pushing. Record the
    decision as DEFERRED with a horizon. Mention safety only if a technician
    note actually says the work is safety-related — if it does not, say nothing
    about safety at all.
  - SCEPTICISM ("is it really needed?", "you people always find something").
    Re-send the media. Offer the old-part inspection at pickup — that offer is
    true of every job here, so you may make it without a source id.
  - A PLAIN QUESTION. Answer it from the bundle's sources and nothing else. If
    the answer is not in a source, say you will check and hand off.
  - CONFUSION, or an older customer sending very short messages. Simplify
    radically — one idea per message — and offer a call proactively rather than
    waiting to be asked.

Whatever they decide, record it with record_customer_decision so the work items
and the ledger match what they actually said.

One message per run. Answer what they asked, then stop — their next message
starts the next run, and that is when you will know whether your answer landed.`,
    /**
     * Three legitimate endings, not one.
     *
     * A decision is the obvious one, and a handoff is the L6 one. But an agent
     * that has *answered the question* has also finished: the customer has not
     * decided yet because they have only just been told something, and a
     * runtime that kept looping would spend its remaining steps talking to
     * itself — or, worse, sending a second message nobody asked for.
     */
    metWhen: ['record_customer_decision', 'handoff_to_human', 'send_customer_message'],
    tools: [
      ...SHARED_TOOLS,
      'adjust_offer',
      'record_customer_decision',
      'schedule_followup',
    ],
  },

  answer_status: {
    key: 'answer_status',
    title: 'Answer "where is my car?" from what the system actually knows',
    instructions: `The customer has asked about their vehicle — where it is, when it will be
ready, what is happening. Answer them.

Read the card and the ETA history first. Then answer from **those and nothing
else**: the card's current state, the ETA and the reason it last moved, and the
lines on the estimate. Every sentence you write must cite one of them.

  - "When will it be ready?" → the current ETA and why it is what it is. If the
    ETA has moved since they were last told, say so and say why. People forgive
    a delay they were told about; they do not forgive discovering one.
  - "Is it done?" → the card's state, in words a person uses. "In quality
    check" means "the work is finished and we are checking it over".
  - "What are you doing to it?" → the approved lines on the estimate. Only the
    approved ones.
  - "How much will it be?" → the estimate total, exactly as it stands. Never a
    figure you worked out yourself.

Do not guess and do not soften. If the ETA is null because nothing has been
scheduled yet, say that a time has not been set and offer to have an advisor
confirm one — that is a true and useful answer, and inventing "later today" is
neither.

## What is not yours

Anything outside those three sources belongs to somebody else, and pretending
otherwise is how this objective would do real damage:

  - **A new complaint** ("there's a noise you didn't fix") — hand off. It needs
    a technician to look at the car, not an assistant to have an opinion.
  - **A discount or a price negotiation on unapproved work** — hand off. You
    have no authority to price anything here, and the approval objective exists
    precisely so that negotiation happens where the floor and ceiling are
    enforced.
  - **A complaint about a person** — hand off, immediately and without
    defending anyone.
  - **A question you cannot answer from a source** — say you will check, and
    hand off.

Answer once and stop. One message, then the run ends; their next message starts
the next run.`,
    /**
     * A sent message and a handoff are both complete answers, and both end the
     * run. The distinction from `resolve_partial_approval` is that this
     * objective has no decision to record — nobody is being asked for anything,
     * which is exactly why it can run at any hour without being a business
     * initiation.
     */
    metWhen: ['send_customer_message', 'handoff_to_human'],
    tools: [...SHARED_TOOLS, 'get_eta'],
  },

  explain_evidence: {
    key: 'explain_evidence',
    title: 'Explain what was found, without asking for a decision',
    instructions: `The customer has asked what was found or why something is needed. Explain it
from the bundle's sources, at their reading level, in their language.

This objective does not ask for money and does not ask for a decision. If the
conversation turns into a decision, that is the approval objective's job — hand
back rather than improvising a request.`,
    metWhen: ['send_customer_message'],
    tools: [...SHARED_TOOLS],
  },
};

export function objectiveSpec(objective: AgentObjective): ObjectiveSpec {
  return OBJECTIVE_SPECS[objective];
}
