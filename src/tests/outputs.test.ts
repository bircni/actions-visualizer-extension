import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../workflow/parse.js";
import { discoverStepOutputs, referencedOutputs, writtenOutputs } from "../workflow/outputs.js";
import type { WorkflowStep } from "../workflow/model.js";

function step(run: string, id?: string): WorkflowStep {
  return { name: "s", isRun: true, continueOnError: false, run, ...(id == null ? {} : { id }) };
}

describe("writtenOutputs", () => {
  it("finds the common redirect form", () => {
    expect(writtenOutputs(step('echo "version=1.2.3" >> $GITHUB_OUTPUT'))).toEqual(["version"]);
  });

  it("tolerates the quoting and spacing variants", () => {
    expect(writtenOutputs(step('echo "a=1" >>$GITHUB_OUTPUT'))).toEqual(["a"]);
    expect(writtenOutputs(step('echo "b=1" >> "$GITHUB_OUTPUT"'))).toEqual(["b"]);
    expect(writtenOutputs(step("echo 'c=1' >>   '$GITHUB_OUTPUT'"))).toEqual(["c"]);
    expect(writtenOutputs(step('echo "d=1" >> ${GITHUB_OUTPUT}'))).toEqual(["d"]);
  });

  it("finds the PowerShell form", () => {
    expect(writtenOutputs(step('"e=1" >> $env:GITHUB_OUTPUT'))).toEqual(["e"]);
  });

  it("finds every output in a multi-line script", () => {
    const script = [
      "set -euo pipefail",
      'echo "version=$VERSION" >> $GITHUB_OUTPUT',
      'echo "sha=$(git rev-parse HEAD)" >> $GITHUB_OUTPUT',
      "make build",
    ].join("\n");
    expect(writtenOutputs(step(script)).toSorted()).toEqual(["sha", "version"]);
  });

  it("finds the heredoc form", () => {
    const script = [
      "{",
      '  echo "notes<<EOF"',
      "  cat CHANGELOG.md",
      "  echo EOF",
      '} >> "$GITHUB_OUTPUT"',
    ].join("\n");
    expect(writtenOutputs(step(script))).toContain("notes");
  });

  it("ignores a heredoc in a script that never mentions the output file", () => {
    expect(writtenOutputs(step("cat <<EOF\nhello\nEOF"))).toEqual([]);
  });

  it("allows a dash in an output name", () => {
    expect(writtenOutputs(step('echo "dry-run=true" >> $GITHUB_OUTPUT'))).toEqual(["dry-run"]);
  });

  it("does not mistake an ordinary redirect or assignment for an output", () => {
    expect(writtenOutputs(step("echo hello >> build.log"))).toEqual([]);
    expect(writtenOutputs(step("VERSION=1.2.3\nmake build"))).toEqual([]);
    expect(writtenOutputs(step("cat $GITHUB_OUTPUT"))).toEqual([]);
  });

  it("returns nothing for a step with no script", () => {
    expect(writtenOutputs({ name: "s", isRun: false, continueOnError: false })).toEqual([]);
    expect(writtenOutputs(step(""))).toEqual([]);
  });
});

describe("referencedOutputs", () => {
  const MODEL = parseWorkflow(
    [
      "on: push",
      "jobs:",
      "  build:",
      "    outputs:",
      "      sha: ${{ steps.meta.outputs.sha }}",
      "      tag: ${{ format('v{0}', steps.meta.outputs.version) }}",
      "    steps:",
      "      - id: meta",
      "        run: echo hi",
      "      - run: echo gated",
      "        if: steps.meta.outputs.ready == 'yes'",
      "  ship:",
      "    needs: build",
      "    if: steps.other.outputs.flag == 'on'",
    ].join("\n"),
  );

  it("collects names from job output expressions, including inside a function call", () => {
    expect([...(referencedOutputs(MODEL).get("meta") ?? [])].toSorted()).toEqual([
      "ready",
      "sha",
      "version",
    ]);
  });

  it("collects names from job and step conditions", () => {
    expect([...(referencedOutputs(MODEL).get("other") ?? [])]).toEqual(["flag"]);
  });

  it("is not fooled by a path that only appears inside a string", () => {
    const model = parseWorkflow(
      "on: push\njobs:\n  a:\n    if: \"'steps.fake.outputs.x' == 'y'\"\n",
    );
    expect(referencedOutputs(model).size).toBe(0);
  });

  it("ignores an expression that does not parse", () => {
    const model = parseWorkflow('on: push\njobs:\n  a:\n    if: "steps.x.outputs.y =="\n');
    expect(referencedOutputs(model).size).toBe(0);
  });

  it("returns nothing for a workflow with no expressions", () => {
    expect(referencedOutputs(parseWorkflow("on: push\njobs:\n  a:\n")).size).toBe(0);
  });
});

describe("discoverStepOutputs", () => {
  it("unions what the script writes with what the workflow reads", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  build:",
        "    outputs:",
        "      sha: ${{ steps.meta.outputs.sha }}",
        "    steps:",
        "      - id: meta",
        '        run: echo "version=1" >> $GITHUB_OUTPUT',
      ].join("\n"),
    );
    const target = model.jobs[0]?.steps[0];
    expect(target).toBeDefined();
    // `version` comes from the script, `sha` from the job output that reads it.
    expect(discoverStepOutputs(target as WorkflowStep, referencedOutputs(model))).toEqual([
      "sha",
      "version",
    ]);
  });

  it("offers only written names for a step with no id", () => {
    const model = parseWorkflow(
      'on: push\njobs:\n  a:\n    steps:\n      - run: echo "x=1" >> $GITHUB_OUTPUT\n',
    );
    const target = model.jobs[0]?.steps[0];
    expect(discoverStepOutputs(target as WorkflowStep, referencedOutputs(model))).toEqual(["x"]);
  });

  it("offers nothing for a step that neither writes nor is read", () => {
    const model = parseWorkflow(
      "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n",
    );
    const target = model.jobs[0]?.steps[0];
    expect(discoverStepOutputs(target as WorkflowStep, referencedOutputs(model))).toEqual([]);
  });
});
