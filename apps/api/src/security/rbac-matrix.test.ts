import { STAFF_ROLES, type StaffRole } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import { AuthController } from '../auth/auth.controller';
import { DeliveryController } from '../loop/delivery.controller';
import { GatePassController } from '../loop/gate-pass.controller';
import { PaymentsWebhookController } from '../loop/payments.controller';
import { StatusController } from '../loop/status.controller';
import { ConversationsController } from '../messaging/conversations.controller';
import { IntakeController } from '../messaging/intake.controller';
import { MediaController } from '../messaging/media.controller';
import { ReviewController } from '../messaging/review.controller';
import { SandboxController } from '../messaging/sandbox.controller';
import { WhatsAppWebhookController } from '../messaging/whatsapp.controller';
import { AuditController } from '../modules/audit.controller';
import { CostsController } from '../ops/costs.controller';
import { TemplatesController } from '../ops/templates.controller';
import { ConfigController } from '../modules/config.controller';
import { HealthController } from '../modules/health.controller';
import { JobCardsController } from '../modules/jobcards.controller';
import { PrivacyController } from '../privacy/privacy.controller';
import { PublicPrivacyController } from '../privacy/public-privacy.controller';
import { AnalyticsController } from '../retention/analytics.controller';
import { RetentionController } from '../retention/retention.controller';
import { CallsController } from '../voice/calls.controller';
import { SoftphoneController } from '../voice/softphone.controller';
import { describeRoutes, routeKey, type RouteDescriptor } from './route-inventory';

/**
 * The RBAC matrix (phase 7.1 acceptance gate: "RBAC matrix test — every
 * endpoint x role").
 *
 * Every route this API exposes appears below with the roles it admits, and the
 * test fails on any disagreement in *either* direction: a route whose
 * decorators changed, and a route that exists in the code and not in this
 * table. The second half is the one that earns its keep — a new controller
 * added next year with no `@Roles()` is open to technicians by default, and
 * without this test nothing anywhere would say so.
 *
 * `ANY` is written out rather than left as an absent entry, so "every
 * authenticated member of staff may call this" is always a decision somebody
 * made and a reviewer saw, never an omission.
 */

const ANY = 'ANY' as const;
const PUBLIC = 'PUBLIC' as const;

type Expectation = readonly StaffRole[] | typeof ANY | typeof PUBLIC;

const CONTROLLERS = [
  AuthController,
  HealthController,
  JobCardsController,
  ConfigController,
  AuditController,
  ConversationsController,
  IntakeController,
  MediaController,
  ReviewController,
  SandboxController,
  WhatsAppWebhookController,
  DeliveryController,
  GatePassController,
  PaymentsWebhookController,
  StatusController,
  CallsController,
  SoftphoneController,
  AnalyticsController,
  RetentionController,
  TemplatesController,
  CostsController,
  PrivacyController,
  PublicPrivacyController,
] as const;

const MATRIX: Readonly<Record<string, Expectation>> = {
  /* --- unauthenticated surface ---------------------------------------- */
  // Everything here is reachable by anybody on the internet, so each entry is
  // a claim that the route protects itself: the OTP routes by rate limit and
  // by a code, the webhooks by provider signature, health by having nothing
  // in it. `PUBLIC` appearing anywhere new is a security review.
  'POST /auth/otp/request': PUBLIC,
  'POST /auth/otp/verify': PUBLIC,
  'POST /auth/refresh': PUBLIC,
  'GET /health': PUBLIC,
  'GET /health/ready': PUBLIC,
  'GET /metrics': PUBLIC,
  'GET /webhooks/whatsapp': PUBLIC,
  'POST /webhooks/whatsapp': PUBLIC,
  'POST /webhooks/payments': PUBLIC,
  // The recipient is a workshop customer with no console account, so a
  // session is impossible. The archive link's credential is a 256-bit token
  // stored as a hash and expiring in hours; the notice carries no personal
  // data at all and is a statutory publication requirement.
  'GET /privacy/download': PUBLIC,
  'GET /privacy/notice': PUBLIC,

  /* --- session -------------------------------------------------------- */
  'POST /auth/logout': ANY,
  'POST /auth/switch-shop': ANY,
  'GET /auth/me': ANY,

  /* --- the shop floor -------------------------------------------------- *
   * Technicians belong here. The board is their work queue, media is the
   * evidence they photograph, and intake is the job card they hand in. */
  'GET /jobcards/board': ANY,
  'GET /jobcards/:id': ANY,
  'POST /jobcards/:id/transitions': ANY,
  'GET /media/:id': ANY,
  'GET /media/:id/thumbnail': ANY,
  'GET /intake/drafts': ANY,
  'GET /intake/drafts/:id': ANY,
  'GET /intake/drafts/:id/summary': ANY,
  'POST /intake/drafts/:id/corrections': ANY,
  'POST /intake/drafts/:id/confirm': ANY,
  'POST /intake/drafts/:id/discard': ANY,
  'POST /intake/job-cards': ANY,
  // Reads the shop's own guardrail document. Visible to everyone the
  // guardrails govern; changing it is the owner's alone, below.
  'GET /config/guardrails': ANY,

  /* --- the counter ----------------------------------------------------- *
   * Customer conversations, money, and anything that speaks in the shop's
   * name. A technician has no business here, which is what phase 7.1
   * tightened. */
  'GET /conversations': ['OWNER', 'ADVISOR'],
  'GET /conversations/:id': ['OWNER', 'ADVISOR'],
  'POST /conversations/:id/read': ['OWNER', 'ADVISOR'],
  'POST /conversations/:id/reply': ['OWNER', 'ADVISOR'],
  'POST /conversations/:id/consent-request': ['OWNER', 'ADVISOR'],
  'GET /review/queue': ['OWNER', 'ADVISOR'],
  'POST /review/:messageId/decide': ['OWNER', 'ADVISOR'],
  'GET /review/tasks': ['OWNER', 'ADVISOR'],
  'POST /review/tasks/:taskId/resolve': ['OWNER', 'ADVISOR'],
  'GET /status/signals/pending': ['OWNER', 'ADVISOR'],
  'GET /status/eta': ['OWNER', 'ADVISOR'],
  'POST /status/signals/confirm': ['OWNER', 'ADVISOR'],
  'POST /status/signals/discard': ['OWNER', 'ADVISOR'],
  'POST /delivery/ready': ['OWNER', 'ADVISOR'],
  'POST /delivery/invoice': ['OWNER', 'ADVISOR'],
  'POST /delivery/payment-link': ['OWNER', 'ADVISOR'],
  'POST /delivery/payment/manual': ['OWNER', 'ADVISOR'],
  'GET /delivery/summary': ['OWNER', 'ADVISOR'],
  'POST /gate-pass/issue': ['OWNER', 'ADVISOR'],
  'GET /voice/calls': ['OWNER', 'ADVISOR'],
  'GET /voice/calls/:callId': ['OWNER', 'ADVISOR'],
  'GET /voice/softphone': ['OWNER', 'ADVISOR'],
  'POST /voice/softphone/originate': ['OWNER', 'ADVISOR'],
  'POST /voice/softphone/inbound': ['OWNER', 'ADVISOR'],
  'POST /voice/softphone/:callId/answer': ['OWNER', 'ADVISOR'],
  'POST /voice/softphone/:callId/speak': ['OWNER', 'ADVISOR'],
  'GET /voice/softphone/:callId/poll': ['OWNER', 'ADVISOR'],
  'POST /voice/softphone/:callId/hangup': ['OWNER', 'ADVISOR'],
  'POST /voice/softphone/:callId/no-answer': ['OWNER', 'ADVISOR'],
  'GET /analytics/summary': ['OWNER', 'ADVISOR'],
  'GET /analytics/export.csv': ['OWNER', 'ADVISOR'],
  'GET /analytics/digests': ['OWNER', 'ADVISOR'],
  'GET /retention/ledger': ['OWNER', 'ADVISOR'],
  'GET /retention/next-visit/:jobCardId': ['OWNER', 'ADVISOR'],
  'GET /retention/touches': ['OWNER', 'ADVISOR'],
  'GET /retention/feedback': ['OWNER', 'ADVISOR'],
  'GET /retention/alerts': ['OWNER', 'ADVISOR'],
  'POST /retention/documents': ['OWNER', 'ADVISOR'],
  'POST /retention/odometer': ['OWNER', 'ADVISOR'],
  'GET /sandbox/personas': ['OWNER', 'ADVISOR'],
  'POST /sandbox/inject': ['OWNER', 'ADVISOR'],
  'GET /sandbox/transcript': ['OWNER', 'ADVISOR'],
  'POST /sandbox/approval-draft': ['OWNER', 'ADVISOR'],

  // Reading the template catalog is onboarding work an advisor does — it is
  // the screen that answers "why did that message not go out". *Recording* an
  // approval is owner-only; see the owner block.
  'GET /ops/templates': ['OWNER', 'ADVISOR'],

  // Taking a data-principal request and verifying who asked is counter work.
  // Authorising the erasure is not — see the owner block below.
  'GET /privacy/requests': ['OWNER', 'ADVISOR'],
  'GET /privacy/requests/:requestId': ['OWNER', 'ADVISOR'],
  'POST /privacy/requests': ['OWNER', 'ADVISOR'],
  'POST /privacy/requests/:requestId/verify': ['OWNER', 'ADVISOR'],
  'POST /privacy/requests/:requestId/cancel': ['OWNER', 'ADVISOR'],

  // The gate: a technician standing at it verifies a pass. They cannot issue
  // one, because issuing is what says the money question is settled.
  'POST /gate-pass/verify': ['OWNER', 'ADVISOR', 'TECHNICIAN'],

  /* --- the owner alone -------------------------------------------------- *
   * Changing a guardrail, releasing a vehicle against an unpaid balance,
   * reading the audit chain, and re-deriving the numbers the shop is judged
   * on. Each is an act with no undo or no supervisor. */
  'PATCH /config/guardrails': ['OWNER'],
  'POST /gate-pass/revoke': ['OWNER'],
  'GET /audit/verify': ['OWNER'],
  'GET /audit/events': ['OWNER'],
  'GET /audit/dead-letter': ['OWNER'],
  'GET /review/graduation': ['OWNER'],
  'POST /analytics/recompute': ['OWNER'],
  // The point of no return, and the two acts either side of it. One person
  // in the shop can reach these; the RBAC matrix is what says so.
  'POST /privacy/requests/:requestId/approve': ['OWNER'],
  'POST /privacy/requests/:requestId/execute': ['OWNER'],
  'POST /privacy/requests/:requestId/reject': ['OWNER'],
  // The shop's cost base, and its compliance record with Meta. An advisor has
  // no decision to make with either, and a template marked APPROVED because
  // somebody believed it ought to be turns a record into an opinion.
  'GET /ops/costs': ['OWNER'],
  'POST /ops/templates/registrations': ['OWNER'],
};

const routes = describeRoutes(CONTROLLERS);

describe('RBAC matrix', () => {
  it('discovers the API surface by reflection', () => {
    // A reflection bug that returned nothing would make every assertion below
    // vacuously true, which is the failure mode of this whole approach.
    expect(routes.length).toBeGreaterThan(50);
  });

  it('has no route missing from the matrix', () => {
    const undeclared = routes.filter((route) => MATRIX[routeKey(route)] === undefined);
    expect(
      undeclared.map(describe_),
      'Every route must declare who may call it. Add each to MATRIX in this file:',
    ).toEqual([]);
  });

  it('has no matrix entry for a route that no longer exists', () => {
    const live = new Set(routes.map(routeKey));
    const stale = Object.keys(MATRIX).filter((key) => !live.has(key));
    expect(stale, 'These matrix entries name routes that do not exist:').toEqual([]);
  });

  it.each(routes.map((route) => [routeKey(route), route] as const))(
    '%s admits exactly the declared roles',
    (key, route) => {
      const expected = MATRIX[key];
      if (expected === PUBLIC) {
        expect(route.isPublic, `${key} must be @Public()`).toBe(true);
        return;
      }

      expect(route.isPublic, `${key} must NOT be @Public()`).toBe(false);

      if (expected === ANY) {
        expect(route.roles, `${key} is declared ANY, so it must carry no @Roles()`).toBeNull();
        return;
      }

      expect([...(route.roles ?? [])].sort()).toEqual([...(expected as readonly StaffRole[])].sort());
    },
  );

  /**
   * The property the matrix exists to protect, stated once rather than
   * relying on a reader spotting it forty rows down: a technician's
   * credentials must not reach customer conversations, money, the audit chain
   * or the shop's numbers.
   */
  it('never admits a technician to the counter, the money or the audit chain', () => {
    const forbidden = [
      '/conversations',
      '/analytics',
      '/retention',
      '/audit',
      '/delivery',
      '/review',
      '/sandbox',
      '/voice',
      '/privacy/requests',
    ];

    const leaks = routes.filter((route) => {
      if (route.isPublic) return false;
      if (!forbidden.some((prefix) => route.path.startsWith(prefix))) return false;
      // `null` means no @Roles(), i.e. every role including TECHNICIAN.
      return route.roles === null || route.roles.includes('TECHNICIAN');
    });

    expect(leaks.map(describe_), 'These routes are reachable by a TECHNICIAN:').toEqual([]);
  });

  it('covers every role in the declared matrix', () => {
    // Guards against a matrix that has quietly stopped mentioning a role
    // because somebody removed its last route.
    const mentioned = new Set<StaffRole>();
    for (const expectation of Object.values(MATRIX)) {
      if (expectation === ANY || expectation === PUBLIC) continue;
      for (const role of expectation) mentioned.add(role);
    }
    expect([...mentioned].sort()).toEqual([...STAFF_ROLES].sort());
  });
});

function describe_(route: RouteDescriptor): string {
  return `${routeKey(route)}  (${route.controller}.${route.handler}, roles=${
    route.roles === null ? 'ANY' : route.roles.join('|')
  })`;
}
