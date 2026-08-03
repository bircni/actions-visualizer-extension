import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../workflow/lint.js";
import { parseWorkflow } from "../workflow/parse.js";
import type { Simulation } from "../workflow/simulate.js";

const PUSH: Simulation = { event: "push", ref: "refs/heads/main", inputs: {} };

function messages(source: string, simulation: Simulation = PUSH): string[] {
  return lintWorkflow(parseWorkflow(source), simulation).map((finding) => finding.message);
}

function findings(source: string, simulation: Simulation = PUSH) {
  return lintWorkflow(parseWorkflow(source), simulation);
}

describe("lintWorkflow needs checks", () => {
  it("reports a `needs:` target that does not exist", () => {
    const result = findings("on: push\njobs:\n  a:\n    needs: ghost\n");
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("error");
    expect(result[0]?.message).toContain("`ghost`");
    expect(result[0]?.range).toBeDefined();
  });

  it("reports a job that needs itself", () => {
    expect(messages("on: push\njobs:\n  a:\n    needs: a\n")).toContainEqual(
      "Job `a` lists itself in `needs:`, so it can never run.",
    );
  });

  it("reports a duplicated `needs:` entry", () => {
    expect(messages("on: push\njobs:\n  a:\n  b:\n    needs: [a, a]\n")).toContainEqual(
      "Job `b` lists `a` in `needs:` more than once.",
    );
  });

  it("stays quiet on a healthy workflow", () => {
    expect(messages("on: push\njobs:\n  a:\n  b:\n    needs: a\n")).toEqual([]);
  });
});

describe("lintWorkflow condition checks", () => {
  it("reports a context a job-level `if:` cannot see", () => {
    // GitHub gives a job condition only github, needs, vars and inputs.
    const result = messages("on: push\njobs:\n  a:\n    if: env.STAGE == 'prod'\n");
    expect(result.some((message) => message.includes("`env`"))).toBe(true);
    expect(result.some((message) => message.includes("only has access to"))).toBe(true);
  });

  it("reports each unavailable context once", () => {
    const result = messages(
      "on: push\njobs:\n  a:\n    if: steps.x.outputs.a == matrix.os\n",
    ).filter((message) => message.includes("only has access to"));
    expect(result).toHaveLength(2);
  });

  it("accepts the contexts a job condition may use", () => {
    expect(
      messages(
        "on: push\njobs:\n  a:\n  b:\n    needs: a\n    if: github.event_name == 'push' && needs.a.result == 'success'\n",
      ),
    ).toEqual([]);
  });

  it("ignores an identifier that is not a context at all", () => {
    // `foo.bar` is not a known context, so it is someone else's problem.
    expect(
      messages("on: push\njobs:\n  a:\n    if: foo.bar == 1\n").filter((message) =>
        message.includes("only has access to"),
      ),
    ).toEqual([]);
  });

  it("reports a condition that can never be true", () => {
    expect(messages("on: push\njobs:\n  a:\n    if: false\n")).toContainEqual(
      "Job `a` has an `if:` that is always false, so it never runs.",
    );
  });

  it("does not call a context-dependent condition constant", () => {
    expect(
      messages("on: push\njobs:\n  a:\n    if: github.event_name == 'push'\n").filter((message) =>
        message.includes("always false"),
      ),
    ).toEqual([]);
  });

  it("reports a condition that does not parse", () => {
    const result = messages('on: push\njobs:\n  a:\n    if: "github.event_name =="\n');
    expect(result.some((message) => message.includes("does not parse"))).toBe(true);
  });
});

describe("lintWorkflow output checks", () => {
  it("notes outputs no other job consumes", () => {
    const result = findings(
      "on: push\njobs:\n  a:\n    outputs:\n      sha: ${{ steps.x.outputs.sha }}\n",
    );
    expect(result.map((finding) => finding.message)).toContainEqual(
      "Job `a` declares outputs, but no other job needs it.",
    );
    expect(result[0]?.severity).toBe("information");
  });

  it("stays quiet when a dependent job exists", () => {
    expect(
      messages(
        "on: push\njobs:\n  a:\n    outputs:\n      sha: ${{ steps.x.outputs.sha }}\n  b:\n    needs: a\n",
      ),
    ).toEqual([]);
  });
});

describe("lintWorkflow resilience", () => {
  it("reports nothing for a file that does not parse", () => {
    expect(messages("name: Broken\non: push\njobs:\n  a:\n   steps: []\n")).toEqual([]);
  });

  it("reports nothing for an empty workflow", () => {
    expect(messages("on: push\n")).toEqual([]);
  });
});
