import { describe, expect, test } from "bun:test";

import {
	type Rule,
	excludePrimaryOnlyRules,
} from "../../src/infrastructure/rule-loader";

function rule(name: string): Rule {
	return {
		name,
		path: `/repo/rules/${name}.md`,
		content: `${name} content`,
		alwaysApply: true,
		_source: {
			provider: "test",
			providerName: "test",
			path: "/repo",
			level: "project",
		},
	};
}

describe("excludePrimaryOnlyRules", () => {
	// Regression test for a live-confirmed incident: a dispatched reviewer's
	// own session_init system prompt carried rules/legion-dispatch.md's
	// content verbatim — a rule meant only for the primary agent (when/how to
	// reach for legion_dispatch, a tool no legion-* persona can ever call).
	test("drops legion-dispatch but keeps every other rule", () => {
		const rules = [
			rule("legion-dispatch"),
			rule("legion-search-tool-bm25"),
			rule("some-user-project-rule"),
		];

		const result = excludePrimaryOnlyRules(rules);

		expect(result.map((r) => r.name)).toEqual([
			"legion-search-tool-bm25",
			"some-user-project-rule",
		]);
	});

	test("is a no-op when legion-dispatch isn't in the discovered set", () => {
		const rules = [rule("legion-search-tool-bm25"), rule("unrelated")];

		expect(excludePrimaryOnlyRules(rules)).toEqual(rules);
	});

	test("handles an empty rule set", () => {
		expect(excludePrimaryOnlyRules([])).toEqual([]);
	});
});
