export const DISPATCH_STRATEGY_SELF_CONSISTENCY = "self-consistency" as const;
export const DISPATCH_STRATEGY_DIVERSE = "diverse" as const;
export const DEFAULT_DISPATCH_STRATEGY = DISPATCH_STRATEGY_SELF_CONSISTENCY;
export const DISPATCH_STRATEGIES = [
	DISPATCH_STRATEGY_SELF_CONSISTENCY,
	DISPATCH_STRATEGY_DIVERSE,
] as const;
/**
 * Cycled by attempt index for self-consistency sampling — deliberate,
 * verified sampling diversity across N identical-model attempts, rather
 * than whatever the provider happens to default to (arXiv 2502.00674's
 * Self-MoA thesis assumes real sampling diversity exists; it previously
 * didn't). Focused -> balanced -> creative.
 */
export const DEFAULT_TEMPERATURE_LADDER = [0.2, 0.6, 1.0] as const;
export const DEFAULT_DECOMPOSITION_TASK_ID = "generalist";
export const DEFAULT_DECOMPOSITION_ROLE = "generalist";
export const LEGION_AGENT_PREFIX = "legion-";
/**
 * The decomposition planner's persona name. Named with the `legion-` prefix
 * so it gets bundled/project/user-override loading for free (same mechanism
 * as every other Legion persona) and so task-tool-guard blocks it from the
 * native `task` tool — but it must never be selectable as an ensemble
 * attempt through legion_dispatch either: it decides *whether and how* to
 * split a task, it isn't a candidate for being one of the split pieces. See
 * host-dispatch-service.ts, which excludes this name from the agent-name set
 * resolveAgentName resolves task roles against.
 */
export const LEGION_DECOMPOSER_AGENT_NAME = "legion-decomposer";
export const LEGION_DISPATCH_JOB_LABEL = "legion-dispatch";
/**
 * Every stage `#run()` can report progress from, attached as `phase` on each
 * `reportProgress` details payload. A structured tag the presentation layer
 * reads directly (`details.phase === "decomposing"`), instead of the prior
 * design of guessing from `text.includes("running")`-style substring checks
 * against freeform prose — accidentally correct as long as no message's
 * wording ever changed, and blind to phases (decomposition, live attempt
 * counts) that had no distinct wording to guess from because nothing
 * reported progress for them at all.
 */
export const LEGION_DISPATCH_PHASES = [
	"decomposing",
	"running",
	"retrying",
	"expanding",
	"synthesizing",
	"escalated",
	"rejected",
	"completed",
	"failed",
] as const;
export type LegionDispatchPhase = (typeof LEGION_DISPATCH_PHASES)[number];
export const LEGION_ORCHESTRATION_ENTRY_TYPE = "legion-orchestration";
export const LEGION_PLUGIN_NAME = "omp-legion";
export const LEGION_SETTING_KEYS = {
	modelMap: "modelMap",
	hotl: "hotl",
	defaultEnsembleSize: "defaultEnsembleSize",
	maxConcurrentExperts: "maxConcurrentExperts",
	verifyCommand: "verifyCommand",
	decisionTimeoutMs: "decisionTimeoutMs",
	confidenceFloor: "hotl.confidenceFloor",
	disagreementThreshold: "hotl.disagreementThreshold",
	costCeiling: "hotl.costCeiling",
	failureRateCeiling: "hotl.failureRateCeiling",
	embedding: "embedding",
	embeddingBaseUrl: "embed.baseUrl",
	embeddingApiKey: "embed.apiKey",
	embeddingModel: "embed.model",
	decomposer: "decomposer",
	decomposerModels: "decomposer.models",
	decomposerTemperatureLadder: "decomposer.temperatureLadder",
} as const;
export const DEFAULT_MODEL_MAP = {} as const;

export const DEFAULT_ENSEMBLE_SIZE = 3;
export const MIN_ENSEMBLE_SIZE = 1;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 10 * 60_000;
export const MAX_ENSEMBLE_SIZE = 16;

/**
 * Legion's own concurrency cap on total in-flight expert attempts per
 * dispatch. The host's task.maxConcurrency semaphore lives only inside
 * TaskTool, never inside the shared runSubprocess executor Legion calls
 * directly (ADR 0002) — without this, a dispatch with several tasks times a
 * large ensemble size would fan out every attempt at once with no limit.
 */
export const DEFAULT_MAX_CONCURRENT_EXPERTS = 4;

export const AGGREGATOR_DISABLE_REASONING = true;

export const DEFAULT_EMBEDDING_THRESHOLD = 0.84;
export const DEFAULT_ROUGE_L_THRESHOLD = 0.82;
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const MAX_ROUGE_L_TOKEN_COUNT = 512;
export const DEFAULT_EMBEDDING_SETTINGS = {
	baseUrl: DEFAULT_OLLAMA_BASE_URL,
	model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
} as const;

export const DEFAULT_CONFIDENCE_FLOOR = 0.6;
/**
 * Under the fragmentation-based disagreement metric (domain/synthesis.ts's
 * fragmentationDisagreement — clusterCount-1 / answerCount-1, no longer
 * `1 - confidence`), 0.75 means "escalate only once genuine scatter shows up
 * (multiple distinct answers), not merely because one attempt dissented from
 * an otherwise-clear majority" — a lone dissenter at the default ensemble
 * size of 3 measures 0.5, comfortably under this floor; a full 3-way split
 * measures 1.0, well over it.
 */
export const DEFAULT_DISAGREEMENT_THRESHOLD = 0.75;
/**
 * A per-attempt mean, not a dispatch-wide sum (application/dispatch-service.ts's
 * expertCost averages, it no longer totals). A flat sum scaled mechanically
 * with ensembleSize — 3 real coding subagents at ~20-30k tokens each (live-
 * tested this session) already sit near a 100k sum ceiling regardless of
 * whether anything was actually wrong, and a larger ensembleSize would only
 * make that worse. 50k as a per-attempt figure gives headroom above typical
 * observed cost while still catching a genuinely runaway attempt.
 */
export const DEFAULT_COST_CEILING = 50_000;
/** Escalate once more than half of a task's attempts failed/aborted outright — see GovernanceThresholds.failureRateCeiling. */
export const DEFAULT_FAILURE_RATE_CEILING = 0.5;

export const DEFAULT_HOTL_THRESHOLDS = {
	confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
	disagreementThreshold: DEFAULT_DISAGREEMENT_THRESHOLD,
	costCeiling: DEFAULT_COST_CEILING,
	failureRateCeiling: DEFAULT_FAILURE_RATE_CEILING,
} as const;

export const HOTL_DECISION_APPROVE = "approve" as const;
export const HOTL_DECISION_REJECT = "reject" as const;
export const HOTL_DECISION_EDIT = "edit" as const;
export const HOTL_DECISION_ACTIONS = [
	HOTL_DECISION_APPROVE,
	HOTL_DECISION_REJECT,
	HOTL_DECISION_EDIT,
] as const;
export const HOTL_DECISION_TITLE = "Legion escalation";
export const HOTL_EDIT_TITLE = "Legion escalation note";
export const HOTL_EDIT_PLACEHOLDER = "Describe the correction or constraint";
export const HOTL_NO_DECISION_PROVIDER_MESSAGE =
	"No human decision provider is available for this escalation.";
export const HOTL_EMPTY_EDIT_MESSAGE =
	"An edit decision requires a non-empty note.";
export const HOTL_DECISION_TIMEOUT_MESSAGE =
	"No human responded before the decision timeout elapsed.";
/** 30 minutes — long enough for a human to actually notice and respond, short enough that a job never waits forever. */
export const DEFAULT_DECISION_TIMEOUT_MS = 30 * 60_000;
/**
 * 5 minutes — a per-expert wall-clock cap. Without this, a single expert
 * stuck retry-looping on a rejected tool call (e.g. a read-only role asked to
 * write a file) hangs the whole ensemble indefinitely: no error, no retry, no
 * escalation, just a static "N-1/N experts finished" forever. A capped
 * attempt fails cleanly instead, and synthesis proceeds with whichever
 * experts did respond (or HOTL's failureRateCeiling escalates if too many
 * did not).
 */
export const DEFAULT_EXPERT_TIMEOUT_MS = 5 * 60_000;
