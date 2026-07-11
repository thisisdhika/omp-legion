export const DISPATCH_STRATEGY_SELF_CONSISTENCY = "self-consistency" as const;
export const DISPATCH_STRATEGY_DIVERSE = "diverse" as const;
export const DEFAULT_DISPATCH_STRATEGY = DISPATCH_STRATEGY_SELF_CONSISTENCY;
export const DISPATCH_STRATEGIES = [
	DISPATCH_STRATEGY_SELF_CONSISTENCY,
	DISPATCH_STRATEGY_DIVERSE,
] as const;
export const DEFAULT_DECOMPOSITION_TASK_ID = "task";
export const DEFAULT_DECOMPOSITION_AGENT = "task";
export const DEFAULT_DECOMPOSITION_ROLE = "generalist";
export const LEGION_AGENT_PREFIX = "legion-";
export const LEGION_DISPATCH_JOB_LABEL = "legion-dispatch";
export const LEGION_ORCHESTRATION_ENTRY_TYPE = "legion-orchestration";
export const LEGION_PLUGIN_NAME = "omp-legion";
export const LEGION_SETTING_KEYS = {
	modelMap: "modelMap",
	hotl: "hotl",
	defaultEnsembleSize: "defaultEnsembleSize",
	confidenceFloor: "hotl.confidenceFloor",
	disagreementThreshold: "hotl.disagreementThreshold",
	costCeiling: "hotl.costCeiling",
	embedding: "embedding",
	embeddingBaseUrl: "embed.baseUrl",
	embeddingApiKey: "embed.apiKey",
	embeddingModel: "embed.model",
} as const;
export const DEFAULT_MODEL_MAP = {} as const;

export const DEFAULT_ENSEMBLE_SIZE = 3;
export const MIN_ENSEMBLE_SIZE = 1;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 10 * 60_000;
export const MAX_ENSEMBLE_SIZE = 16;

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
export const DEFAULT_DISAGREEMENT_THRESHOLD = 0.4;
export const DEFAULT_COST_CEILING = 100_000;

export const DEFAULT_HOTL_THRESHOLDS = {
	confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
	disagreementThreshold: DEFAULT_DISAGREEMENT_THRESHOLD,
	costCeiling: DEFAULT_COST_CEILING,
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
