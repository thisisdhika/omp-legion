import { DEFAULT_HOTL_THRESHOLDS, HOTL_DECISION_ACTIONS } from "./constants";

export type EscalationReason = "confidence" | "disagreement" | "cost";

export interface GovernanceThresholds {
	readonly confidenceFloor: number;
	readonly disagreementThreshold: number;
	readonly costCeiling: number;
}

export interface GovernanceMetrics {
	readonly confidence: number;
	readonly disagreement: number;
	readonly cost: number;
}

export interface GovernanceDecision {
	readonly shouldEscalate: boolean;
	readonly reasons: readonly EscalationReason[];
	readonly metrics: GovernanceMetrics;
	readonly thresholds: GovernanceThresholds;
}

export type HumanDecisionAction = (typeof HOTL_DECISION_ACTIONS)[number];

export interface HumanDecision {
	readonly action: HumanDecisionAction;
	readonly note?: string;
}

export interface GovernanceResolution extends HumanDecision {
	readonly taskId: string;
}

export function isHumanDecisionAction(
	value: string | undefined,
): value is HumanDecisionAction {
	return (
		value !== undefined &&
		HOTL_DECISION_ACTIONS.includes(value as HumanDecisionAction)
	);
}

export function evaluateGovernance(input: {
	metrics: GovernanceMetrics;
	thresholds?: GovernanceThresholds;
}): GovernanceDecision {
	const thresholds = input.thresholds ?? DEFAULT_HOTL_THRESHOLDS;
	const reasons: EscalationReason[] = [];
	if (input.metrics.confidence < thresholds.confidenceFloor)
		reasons.push("confidence");
	if (input.metrics.disagreement > thresholds.disagreementThreshold)
		reasons.push("disagreement");
	if (input.metrics.cost > thresholds.costCeiling) reasons.push("cost");
	return {
		shouldEscalate: reasons.length > 0,
		reasons,
		metrics: input.metrics,
		thresholds,
	};
}
