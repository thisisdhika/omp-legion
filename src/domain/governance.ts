import { DEFAULT_HOTL_THRESHOLDS, HOTL_DECISION_ACTIONS } from "./constants";

export type EscalationReason =
	| "confidence"
	| "disagreement"
	| "cost"
	| "failureRate";

export interface GovernanceThresholds {
	readonly confidenceFloor: number;
	readonly disagreementThreshold: number;
	readonly costCeiling: number;
	/**
	 * Independent of confidence: confidence is computed only over experts that
	 * actually produced an answer (domain/synthesis.ts's answerCandidates
	 * filters out empty/failed output before clustering), so a task where 2 of
	 * 3 experts crashed and 1 survived reports confidence 1.0 — the single
	 * worst-case outcome for an ensemble reads as maximum confidence. This
	 * threshold sees the raw attempt failure rate directly, so that case
	 * cannot hide behind whatever the survivor said.
	 */
	readonly failureRateCeiling: number;
}

export interface GovernanceMetrics {
	readonly confidence: number;
	readonly disagreement: number;
	readonly cost: number;
	/** Fraction of attempts that failed/aborted, independent of what synthesis/clustering saw. */
	readonly failureRate: number;
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
	if (input.metrics.failureRate > thresholds.failureRateCeiling)
		reasons.push("failureRate");
	return {
		shouldEscalate: reasons.length > 0,
		reasons,
		metrics: input.metrics,
		thresholds,
	};
}
