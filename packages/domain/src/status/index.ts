/**
 * The status sentinel's domain surface (phase 4.2 / 4.3 / 4.4 / 4.6).
 *
 * Model-free, like every other domain module here: the ETA engine is a rules
 * table, the routing is a pure decision over a confidence and a match, and the
 * only thing that touches a language model is the *parser*, which enters
 * through a port. That is what lets the whole middle of the loop be tested
 * exhaustively without a credential.
 */

export {
  classifyEtaChange,
  computeEta,
  isCommitted,
  minutesFor,
  requiresImmediateNotice,
  type EtaComputation,
  type EtaComputeInput,
  type EtaWorkItem,
  type MaterialityInput,
  type MaterialityVerdict,
} from './eta-rules';

export {
  EtaService,
  describeChange,
  toEtaWorkItems,
  type EtaServiceDeps,
  type RecalculateInput,
  type RecalculateResult,
} from './eta-service';

export {
  AUTO_APPLY_CONFIDENCE,
  MIN_FRAGMENT_LENGTH,
  normaliseFragment,
  registrationMatches,
  resolveCard,
  shouldAutoApply,
  type MatchInput,
  type MatchOutcome,
} from './card-matching';

export {
  StatusSignalService,
  cardEventFor,
  decideRoute,
  etaReasonFor,
  resolveWorkItems,
  titleMatches,
  type CaptureStatusSignalInput,
  type StatusSignalServiceDeps,
} from './status-signal-service';

export {
  StatusCommsService,
  etaSourceKey,
  formatLocalTime,
  type AnnounceResult,
  type StatusCommsDeps,
} from './status-comms';

export {
  SilentBaySentinel,
  isActiveForSilence,
  truncateToWindow,
  type ScanInput,
  type ScanResult,
  type SilentBayDeps,
} from './silent-bay';

export type {
  CaptureOutcome,
  ParsedStatusSignal,
  StatusSignalParser,
} from './types';

export type {
  CardCandidate,
  CardResolver,
  EtaEntry,
  EtaHead,
  EtaStore,
  SilentBayStore,
  SilentCard,
  StatusCommsStore,
  StatusSignalRecord,
  StatusSignalStore,
} from './ports';
