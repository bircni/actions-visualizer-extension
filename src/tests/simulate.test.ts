import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../workflow/parse.js";
import {
  buildContexts,
  defaultInputValue,
  inputsFor,
  refChoicesFor,
  simulateJobs,
  withInputDefaults,
  type Simulation,
} from "../workflow/simulate.js";
import { evaluate } from "../workflow/expression/evaluate.js";

const DISPATCH = [
  "on:",
  "  push:",
  "    branches: [main, 'release/*']",
  "    tags: ['v*']",
  "  workflow_dispatch:",
  "    inputs:",
  "      environment:",
  "        type: choice",
  "        options: [staging, production]",
  "        default: staging",
  "      dry-run:",
  "        type: boolean",
  "        default: false",
  "jobs:",
  "  build:",
  "    steps: []",
  "  deploy:",
  "    needs: build",
  "    if: inputs.environment == 'production'",
  "    steps: []",
  "  notify:",
  "    needs: deploy",
  "    steps: []",
  "  always-run:",
  "    needs: deploy",
  "    if: always()",
  "    steps: []",
].join("\n");

function states(source: string, simulation: Simulation): Record<string, string> {
  const model = parseWorkflow(source);
  const result: Record<string, string> = {};
  for (const [id, entry] of simulateJobs(model, simulation)) {
    result[id] = entry.state;
  }
  return result;
}

describe("refChoicesFor", () => {
  it("offers a ref per declared branch and tag, with wildcards made concrete", () => {
    const push = parseWorkflow(DISPATCH).triggers[0];
    expect(refChoicesFor(push)).toEqual([
      { label: "main", ref: "refs/heads/main" },
      { label: "release/x", ref: "refs/heads/release/x" },
      { label: "vx", ref: "refs/tags/vx" },
    ]);
  });

  it("falls back to main when an event declares no filters", () => {
    const dispatch = parseWorkflow(DISPATCH).triggers[1];
    expect(refChoicesFor(dispatch)).toEqual([{ label: "main", ref: "refs/heads/main" }]);
    expect(refChoicesFor()).toEqual([]);
  });
});

describe("inputs", () => {
  it("finds the inputs declared by the selected event", () => {
    const model = parseWorkflow(DISPATCH);
    expect(inputsFor(model, "workflow_dispatch").map((input) => input.name)).toEqual([
      "environment",
      "dry-run",
    ]);
    expect(inputsFor(model, "push")).toEqual([]);
    expect(inputsFor(model)).toEqual([]);
  });

  it("starts each input at its declared default, then a sensible one per type", () => {
    expect(defaultInputValue({ name: "a", type: "string", required: false, default: "x" })).toBe(
      "x",
    );
    expect(defaultInputValue({ name: "a", type: "boolean", required: false })).toBe(false);
    expect(defaultInputValue({ name: "a", type: "number", required: false })).toBe(0);
    expect(defaultInputValue({ name: "a", type: "string", required: false })).toBe("");
    expect(
      defaultInputValue({ name: "a", type: "choice", required: false, options: ["p", "q"] }),
    ).toBe("p");
  });

  it("fills in defaults for inputs the user has not set", () => {
    const model = parseWorkflow(DISPATCH);
    expect(withInputDefaults(model, { event: "workflow_dispatch", inputs: {} })).toEqual({
      environment: "staging",
      "dry-run": false,
    });
    expect(
      withInputDefaults(model, {
        event: "workflow_dispatch",
        inputs: { environment: "production" },
      }),
    ).toEqual({ environment: "production", "dry-run": false });
  });
});

describe("buildContexts", () => {
  const model = parseWorkflow(DISPATCH);

  it("exposes the event, ref and inputs", () => {
    const contexts = buildContexts(model, {
      event: "push",
      ref: "refs/heads/main",
      inputs: {},
    });
    expect(evaluate("github.event_name", contexts)).toBe("push");
    expect(evaluate("github.ref", contexts)).toBe("refs/heads/main");
    expect(evaluate("github.ref_name", contexts)).toBe("main");
    expect(evaluate("github.ref_type", contexts)).toBe("branch");
  });

  it("reports a tag ref as a tag", () => {
    const contexts = buildContexts(model, { event: "push", ref: "refs/tags/v1", inputs: {} });
    expect(evaluate("github.ref_type", contexts)).toBe("tag");
    expect(evaluate("github.ref_name", contexts)).toBe("v1");
  });

  it("also exposes inputs under the older github.event.inputs spelling", () => {
    const contexts = buildContexts(model, { event: "workflow_dispatch", inputs: {} });
    expect(evaluate("inputs.environment", contexts)).toBe("staging");
    expect(evaluate("github.event.inputs.environment", contexts)).toBe("staging");
  });
});

describe("simulateJobs", () => {
  it("runs every job when no job is conditional", () => {
    expect(
      states("on: push\njobs:\n  a:\n    steps: []\n  b:\n    needs: a\n", { inputs: {} }),
    ).toEqual({ a: "run", b: "run" });
  });

  it("skips a job whose condition is false for the selected event", () => {
    const source = "on: [push, pull_request]\njobs:\n  a:\n    if: github.event_name == 'push'\n";
    expect(states(source, { event: "push", inputs: {} })).toEqual({ a: "run" });
    expect(states(source, { event: "pull_request", inputs: {} })).toEqual({ a: "skipped" });
  });

  it("reacts to an input change", () => {
    const staging = states(DISPATCH, { event: "workflow_dispatch", inputs: {} });
    expect(staging).toMatchObject({ build: "run", deploy: "skipped", notify: "skipped" });

    const production = states(DISPATCH, {
      event: "workflow_dispatch",
      inputs: { environment: "production" },
    });
    expect(production).toMatchObject({ build: "run", deploy: "run", notify: "run" });
  });

  it("propagates a skip through the needs chain", () => {
    const result = states(DISPATCH, { event: "workflow_dispatch", inputs: {} });
    // `notify` has no `if:` of its own; it is skipped purely because `deploy` is.
    expect(result["notify"]).toBe("skipped");
  });

  it("lets always() opt out of the dependency skip", () => {
    const result = states(DISPATCH, { event: "workflow_dispatch", inputs: {} });
    expect(result["always-run"]).toBe("run");
  });

  it("marks a job unknown when its condition cannot be decided", () => {
    const source = "on: push\njobs:\n  a:\n    if: secrets.TOKEN != ''\n";
    expect(states(source, { event: "push", inputs: {} })).toEqual({ a: "unknown" });
  });

  it("spreads unknown to jobs that depend on an unknown job", () => {
    const source = [
      "on: push",
      "jobs:",
      "  a:",
      "    if: needs.x.outputs.ready == 'yes'",
      "  b:",
      "    needs: a",
    ].join("\n");
    expect(states(source, { event: "push", inputs: {} })).toEqual({ a: "unknown", b: "unknown" });
  });

  it("reports why a job is in its state", () => {
    const model = parseWorkflow(DISPATCH);
    const result = simulateJobs(model, { event: "workflow_dispatch", inputs: {} });
    expect(result.get("deploy")?.reason).toContain("`if:` is false");
    expect(result.get("notify")?.reason).toContain("`deploy` is skipped");
  });

  it("terminates on a needs cycle instead of looping forever", () => {
    const source = "on: push\njobs:\n  a:\n    needs: c\n  b:\n    needs: a\n  c:\n    needs: b\n";
    expect(states(source, { event: "push", inputs: {} })).toEqual({
      a: "run",
      b: "run",
      c: "run",
    });
  });

  it("treats a malformed condition as unknown, with the parse error as the reason", () => {
    const model = parseWorkflow('on: push\njobs:\n  a:\n    if: "github.event_name =="\n');
    const result = simulateJobs(model, { event: "push", inputs: {} });
    expect(result.get("a")?.state).toBe("unknown");
    expect(result.get("a")?.reason).toContain("Could not evaluate");
  });
});
