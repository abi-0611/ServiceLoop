/** DI tokens for infrastructure that is constructed, not decorated. */
export const DATABASE = Symbol('serviceloop.database');
export const REDIS = Symbol('serviceloop.redis');
export const STORAGE = Symbol('serviceloop.storage');
export const NOTIFIER = Symbol('serviceloop.notifier');
export const AUDIT_SERVICE = Symbol('serviceloop.audit');
export const OUTBOX_SERVICE = Symbol('serviceloop.outbox');
export const UNIT_OF_WORK = Symbol('serviceloop.uow');
export const JOB_CARD_REPOSITORY = Symbol('serviceloop.jobCardRepository');
export const STAFF_REPOSITORY = Symbol('serviceloop.staffRepository');
export const JOB_CARD_TRANSITION_SERVICE = Symbol('serviceloop.jobCardTransitions');
export const WORK_ITEM_TRANSITION_SERVICE = Symbol('serviceloop.workItemTransitions');
export const GUARDRAIL_SERVICE = Symbol('serviceloop.guardrails');
