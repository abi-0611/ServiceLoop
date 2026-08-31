export {
  EntityResolutionError,
  EntityResolutionService,
  type CustomerMatch,
  type EntityLookup,
  type EntityResolutionDeps,
  type MergeSuggestionRecord,
  type Resolution,
  type ResolutionProblem,
  type ResolveInput,
  type VehicleMatch,
} from './entity-resolution';

export {
  DraftNotConfirmableError,
  DraftNotFoundError,
  IntakeService,
  type ConfirmResult,
  type DraftCreatedResult,
  type IntakeServiceDeps,
  type RecordDraftInput,
} from './intake-service';

export type {
  CreateEstimateLineInput,
  CreateJobCardInput,
  CreateWorkItemInput,
  DraftRecord,
  DraftStore,
  InsertDraftInput,
  JobCardWriter,
} from './ports';

export {
  draftActionButtons,
  draftSummaryContent,
  IntakeExtractionFailedError,
  IntakePipeline,
  type DraftExtractionPort,
  type ExtractedDraft,
  type IntakePipelineDeps,
  type IntakeRunResult,
  type PhotoExtractInput,
  type RunIntakeInput,
  type TextExtractInput,
  type VoiceExtractInput,
} from './intake-pipeline';

export {
  buildDraftSummary,
  DRAFT_ACTION_IDS,
  parseDraftAction,
  parseQuickCorrection,
  pathForLine,
  type DraftSummary,
  type DraftSummaryLine,
  type ParsedDraftAction,
  type QuickCorrection,
} from './confirmation';
