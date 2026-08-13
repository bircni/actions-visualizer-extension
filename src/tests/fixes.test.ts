import { describe, expect, it } from "vitest";
import { fixAllSafe, fixesForFinding, type WorkflowTextEdit } from "../workflow/fixes.js";
import { lintWorkflow, type LintCode } from "../workflow/lint.js";
import { parseWorkflow } from "../workflow/parse.js";

function setup(source: string) {
  const model = parseWorkflow(source);
  return { model, findings: lintWorkflow(model, { inputs: {} }) };
}

function apply(source: string, edits: readonly WorkflowTextEdit[]): string {
  return [...edits]
    .toSorted((left, right) => right.range.start - left.range.start)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.range.start) + edit.replacement + text.slice(edit.range.end),
      source,
    );
}

function finding(source: string, code: LintCode) {
  const state = setup(source);
  const match = state.findings.find((candidate) => candidate.code === code);
  expect(match).toBeDefined();
  return { ...state, finding: match! };
}

describe("workflow quick fixes", () => {
  it("removes a duplicate from a block sequence without touching surrounding comments", () => {
    const source = [
      "on: push",
      "jobs:",
      "  build:",
      "  deploy:",
      "    # dependencies stay documented",
      "    needs:",
      "      - build",
      "      - build # duplicate",
      "    runs-on: linux",
      "",
    ].join("\n");
    const state = finding(source, "duplicate-needs");
    const fixes = fixesForFinding(source, state.model, state.finding);
    expect(fixes).toMatchObject([
      { title: "Remove duplicate dependency 'build'", preferred: true },
    ]);
    expect(apply(source, fixes[0]?.edits ?? [])).toBe(
      source.replace("      - build # duplicate\n", ""),
    );
  });

  it("preserves flow-sequence spelling and comments when removing a duplicate", () => {
    const source =
      "on: push\njobs:\n  a:\n  b:\n    needs: [a, # duplicate follows\n      'a'] # keep me\n";
    const state = finding(source, "duplicate-needs");
    const fixes = fixesForFinding(source, state.model, state.finding);
    expect(apply(source, fixes[0]?.edits ?? [])).toBe(
      "on: push\njobs:\n  a:\n  b:\n    needs: [a # duplicate follows\n      ] # keep me\n",
    );
  });

  it("removes the complete property when its only dependency is removed", () => {
    const source = "on: push\njobs:\n  a:\n    needs: a\n    runs-on: linux\n";
    const state = finding(source, "self-needs");
    const fixes = fixesForFinding(source, state.model, state.finding);
    expect(apply(source, fixes[0]?.edits ?? [])).toBe(
      "on: push\njobs:\n  a:\n    runs-on: linux\n",
    );
  });

  it("removes every occurrence of a repeated self-dependency", () => {
    const source = "on: push\njobs:\n  a:\n    needs: [a, a]\n    runs-on: linux\n";
    const state = finding(source, "self-needs");
    const fixes = fixesForFinding(source, state.model, state.finding);
    expect(apply(source, fixes[0]?.edits ?? [])).toBe(
      "on: push\njobs:\n  a:\n    runs-on: linux\n",
    );
  });

  it("offers missing dependency removal as an explicit non-preferred action", () => {
    const source = "on: push\njobs:\n  a:\n    needs: ghost\n";
    const state = finding(source, "missing-needs");
    expect(fixesForFinding(source, state.model, state.finding)).toMatchObject([
      { title: "Remove undefined dependency 'ghost'", preferred: false },
    ]);
  });

  it("offers explicit condition and outputs removal", () => {
    const conditionSource = "on: push\njobs:\n  a:\n    if: false # disabled\n    runs-on: linux\n";
    const condition = finding(conditionSource, "always-false-condition");
    const conditionFix = fixesForFinding(conditionSource, condition.model, condition.finding)[0];
    expect(conditionFix?.title).toBe("Remove always-false condition (job will run)");
    expect(apply(conditionSource, conditionFix?.edits ?? [])).toBe(
      "on: push\njobs:\n  a:\n    runs-on: linux\n",
    );

    const outputsSource = [
      "on: push",
      "jobs:",
      "  a:",
      "    outputs:",
      "      sha: ${{ steps.x.outputs.sha }} # generated",
      "    runs-on: linux",
      "",
    ].join("\n");
    const outputs = finding(outputsSource, "unconsumed-outputs");
    const outputsFix = fixesForFinding(outputsSource, outputs.model, outputs.finding)[0];
    expect(outputsFix?.title).toBe("Remove unconsumed outputs block");
    expect(apply(outputsSource, outputsFix?.edits ?? [])).toBe(
      "on: push\njobs:\n  a:\n    runs-on: linux\n",
    );
  });

  it("does not invent a rewrite for an invalid job context", () => {
    const source = "on: push\njobs:\n  a:\n    if: env.STAGE == 'prod'\n";
    const state = finding(source, "invalid-job-context");
    expect(fixesForFinding(source, state.model, state.finding)).toEqual([]);
  });

  it("combines overlapping safe findings into one non-overlapping edit set", () => {
    const source = "on: push\njobs:\n  a:\n    needs: [a, a]\n  b:\n    needs: [a, a]\n";
    const state = setup(source);
    const edits = fixAllSafe(source, state.model, state.findings);
    expect(edits).toHaveLength(3);
    expect(apply(source, edits)).toBe("on: push\njobs:\n  a:\n  b:\n    needs: [a]\n");
  });
});
