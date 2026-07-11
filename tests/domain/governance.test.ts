import { describe, expect, test } from "bun:test";

import { evaluateGovernance } from "../../src/domain/governance";

const thresholds = {
	confidenceFloor: 0.6,
	disagreementThreshold: 0.4,
	costCeiling: 100,
};

describe("evaluateGovernance", () => {
	test("escalates when confidence is below its floor", () => {
		const decision = evaluateGovernance({
			metrics: { confidence: 0.59, disagreement: 0.1, cost: 10 },
			thresholds,
		});

		expect(decision).toMatchObject({
			shouldEscalate: true,
			reasons: ["confidence"],
		});
	});

	test("escalates when disagreement is above its threshold", () => {
		const decision = evaluateGovernance({
			metrics: { confidence: 0.8, disagreement: 0.41, cost: 10 },
			thresholds,
		});

		expect(decision).toMatchObject({
			shouldEscalate: true,
			reasons: ["disagreement"],
		});
	});

	test("escalates when cost is above its ceiling", () => {
		const decision = evaluateGovernance({
			metrics: { confidence: 0.8, disagreement: 0.2, cost: 101 },
			thresholds,
		});

		expect(decision).toMatchObject({
			shouldEscalate: true,
			reasons: ["cost"],
		});
	});

	test("does not escalate when all metrics are within thresholds", () => {
		const decision = evaluateGovernance({
			metrics: { confidence: 0.6, disagreement: 0.4, cost: 100 },
			thresholds,
		});

		expect(decision).toMatchObject({
			shouldEscalate: false,
			reasons: [],
		});
	});
});
