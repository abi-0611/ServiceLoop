/**
 * The messaging module's public surface.
 *
 * Note what is exported and what is not: `OutboundGate` is the only thing here
 * that can put a message on a channel. The `ChannelSender` *interface* is
 * exported so `packages/adapters` can implement it and the composition root can
 * wire it, but no helper, convenience function or "just send this" escape hatch
 * exists — by construction, not by convention. `no-bypass.test.ts` proves the
 * property holds across the whole repository.
 */

export {
  APPROVAL_ACTION_IDS,
  parseApprovalAction,
  type ApprovalAction,
} from './approval-actions';

export {
  SLOT_ACTION_IDS,
  STATUS_ACTION_IDS,
  parseSlotAction,
  parseStatusAction,
  type ParsedSlotAction,
  type ParsedStatusAction,
  type StatusActionKind,
} from './status-actions';

export {
  ConversationSessionService,
  CUSTOMER_SERVICE_WINDOW_MS,
  groupThreadKey,
  isGroupThreadKey,
  isWindowOpen,
  personThreadKey,
  windowExpiryFrom,
  windowRemainingMs,
  type OpenThreadInput,
  type SessionServiceDeps,
  type WindowState,
} from './session';

export {
  InboundRouter,
  inboundMessageKind,
  type FollowUp,
  type RouteRequest,
  type RoutedMessage,
  type RouterDeps,
} from './router';

export {
  ConsentService,
  type ConsentServiceDeps,
  type ConsentState,
  type RecordConsentInput,
} from './consent';

export {
  OutboundGate,
  type GateOutcome,
  type OutboundGateDeps,
  type OutboundRequest,
} from './outbound-gate';

export {
  buildConsentRequest,
  CONSENT_ACTION_IDS,
  ConsentCaptureService,
  parseConsentAction,
  type ConsentCaptureDeps,
  type FirstContactResult,
  type OpenFirstContactInput,
  type ParsedConsentAction,
} from './consent-capture';

export {
  MediaService,
  type IngestInboundInput,
  type InsertMediaAssetInput,
  type MediaAssetRecord,
  type MediaIngestOutcome,
  type MediaIngestPort,
  type MediaIngestRequest,
  type MediaIngestResult,
  type MediaRejection,
  type MediaServiceDeps,
  type MediaStore,
  type StoredMediaDescriptor,
} from './media';

export {
  InboundHandler,
  type FetchedMedia,
  type HandleInboundInput,
  type InboundHandlerDeps,
  type InboundOutcome,
  type MediaFetchPort,
  type TraceStep,
} from './inbound-handler';

export {
  DeferredSendService,
  type DeferredSendDeps,
  type DrainResult,
  type MediaBytesLoader,
} from './deferred';

export { disclosesAi } from './outbound-gate';

export { noteIdentifiesAVehicle } from './ports';

export type {
  ApprovalReplyInput,
  ApprovalReplyPort,
  ApprovalReplyResult,
  ChannelSendRequest,
  ChannelSendResult,
  ChannelSender,
  ConsentStore,
  ConversationStore,
  CreateConversationInput,
  CustomerLookup,
  InsertMessageInput,
  MessageStore,
  ScheduledMessage,
  SlotReplyPort,
  StatusTapInput,
  TechnicianNoteCaptureInput,
  TechnicianNotePort,
  TechnicianNoteReadInput,
  TechnicianNoteReading,
} from './ports';

export type {
  ConsentSnapshotRow,
  ConversationSnapshot,
  InboundMediaHandle,
  InboundMessage,
  MessageSnapshot,
  OutboundButton,
  OutboundContent,
  OutboundListRow,
  OutboundListSection,
} from './types';
