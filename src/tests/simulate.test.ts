import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../workflow/parse.js";
import {
  buildContexts,
  defaultInputValue,
  inputsFor,
  refChoicesFor,
  simulateJobs,
  triggerFires,
  unresolvedPaths,
  withInputDefaults,
  type Simulation,
} from "../workflow/simulate.js";
import { UNKNOWN, evaluate } from "../workflow/expression/evaluate.js";

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
      "  setup:",
      "    outputs:",
      "      ready: ${{ steps.x.outputs.ready }}",
      "  a:",
      "    needs: setup",
      "    if: needs.setup.outputs.ready == 'yes'",
      "  b:",
      "    needs: a",
    ].join("\n");
    expect(states(source, { event: "push", inputs: {} })).toEqual({
      setup: "run",
      a: "unknown",
      b: "unknown",
    });
  });

  it("treats a reference to an output no job declares as absent, not unknown", () => {
    // `needs.setup.outputs.nope` can never have a value, so the condition is
    // decidably false rather than undecidable.
    const source = [
      "on: push",
      "jobs:",
      "  setup:",
      "    outputs:",
      "      ready: ${{ steps.x.outputs.ready }}",
      "  a:",
      "    needs: setup",
      "    if: needs.setup.outputs.nope == 'yes'",
    ].join("\n");
    expect(states(source, { event: "push", inputs: {} })).toEqual({ setup: "run", a: "skipped" });
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

describe("context availability", () => {
  const WITH_ENV = [
    "on: push",
    "env:",
    "  GLOBAL: workflow",
    "  DYNAMIC: ${{ github.sha }}",
    "jobs:",
    "  a:",
    "    env:",
    "      SCOPED: job",
    "    steps:",
    "      - run: echo 1",
  ].join("\n");

  it("exposes env to a step condition but not to a job condition", () => {
    const model = parseWorkflow(WITH_ENV);
    const job = model.jobs[0];

    // GitHub's context availability table: a job-level `if:` cannot see `env`.
    const jobScope = buildContexts(model, { event: "push", inputs: {} }, { scope: "job" });
    expect(evaluate("env.GLOBAL", jobScope)).toBe(UNKNOWN);

    const stepScope = buildContexts(
      model,
      { event: "push", inputs: {} },
      { scope: "step", ...(job ? { job } : {}) },
    );
    expect(evaluate("env.GLOBAL", stepScope)).toBe("workflow");
    expect(evaluate("env.SCOPED", stepScope)).toBe("job");
  });

  it("treats an env value built from an expression as unknown", () => {
    const model = parseWorkflow(WITH_ENV);
    const contexts = buildContexts(
      model,
      { event: "push", inputs: {} },
      { scope: "step", ...(model.jobs[0] ? { job: model.jobs[0] } : {}) },
    );
    expect(evaluate("env.DYNAMIC", contexts)).toBe(UNKNOWN);
  });

  it("keeps secrets and vars unknown rather than absent", () => {
    const contexts = buildContexts(parseWorkflow(DISPATCH), { event: "push", inputs: {} });
    expect(evaluate("secrets.TOKEN", contexts)).toBe(UNKNOWN);
    expect(evaluate("vars.REGION", contexts)).toBe(UNKNOWN);
  });
});

describe("step conditions", () => {
  const SOURCE = [
    "on: [push, pull_request]",
    "env:",
    "  STAGE: prod",
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: always",
    "      - run: only-push",
    "        if: github.event_name == 'push'",
    "      - run: env-gated",
    "        if: env.STAGE == 'prod'",
    "      - run: unknowable",
    "        if: steps.earlier.outputs.ok == 'yes'",
  ].join("\n");

  it("evaluates each step against the step-scoped contexts", () => {
    const model = parseWorkflow(SOURCE);
    const onPush = simulateJobs(model, { event: "push", inputs: {} });
    expect(onPush.get("a")?.steps).toEqual(["run", "run", "run", "unknown"]);

    const onPr = simulateJobs(model, { event: "pull_request", inputs: {} });
    expect(onPr.get("a")?.steps).toEqual(["run", "skipped", "run", "unknown"]);
  });

  it("reports no step states for a job with no steps", () => {
    const model = parseWorkflow("on: push\njobs:\n  a:\n");
    expect(simulateJobs(model, { event: "push", inputs: {} }).get("a")?.steps).toEqual([]);
  });
});

describe("pinning unknown values", () => {
  const GATED = [
    "on: push",
    "jobs:",
    "  deploy:",
    "    if: secrets.DEPLOY_KEY != ''",
    "    outputs:",
    "      url: ${{ steps.deploy.outputs.url }}",
    "  nested:",
    "    needs: deploy",
    "    if: needs.deploy.outputs.url != ''",
  ].join("\n");

  it("lists every context path a workflow's conditions cannot resolve", () => {
    const model = parseWorkflow(GATED);
    expect(unresolvedPaths(model, { event: "push", inputs: {} })).toEqual([
      "needs.deploy.outputs.url",
      "secrets.DEPLOY_KEY",
    ]);
  });

  it("decides a condition once its value is pinned", () => {
    const model = parseWorkflow(GATED);
    expect(simulateJobs(model, { event: "push", inputs: {} }).get("deploy")?.state).toBe("unknown");

    const pinned = simulateJobs(model, {
      event: "push",
      inputs: {},
      pinned: { "secrets.DEPLOY_KEY": "abc123" },
    });
    expect(pinned.get("deploy")?.state).toBe("run");

    const empty = simulateJobs(model, {
      event: "push",
      inputs: {},
      pinned: { "secrets.DEPLOY_KEY": "" },
    });
    expect(empty.get("deploy")?.state).toBe("skipped");
  });

  it("pins a deeply nested path without losing the rest of the context", () => {
    const model = parseWorkflow(GATED);
    const contexts = buildContexts(model, {
      event: "push",
      inputs: {},
      pinned: { "needs.deploy.outputs.url": "https://example.com" },
    });
    expect(evaluate("needs.deploy.outputs.url", contexts)).toBe("https://example.com");
    // Pinning one path must not make its siblings resolvable.
    expect(evaluate("secrets.OTHER", contexts)).toBe(UNKNOWN);
    // ...nor clobber contexts the simulation already knew.
    expect(evaluate("github.event_name", contexts)).toBe("push");
  });

  it("does not disturb other jobs when one job's output is pinned", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  alpha:",
        "    outputs:",
        "      one: ${{ steps.a.outputs.one }}",
        "  beta:",
        "    outputs:",
        "      two: ${{ steps.b.outputs.two }}",
      ].join("\n"),
    );
    const contexts = buildContexts(model, {
      event: "push",
      inputs: {},
      pinned: { "needs.alpha.outputs.one": "v1" },
    });

    expect(evaluate("needs.alpha.outputs.one", contexts)).toBe("v1");
    // `needs` is fully known, so pinning into it must not turn its siblings
    // partial: a declared-but-unrun output stays unknown...
    expect(evaluate("needs.beta.outputs.two", contexts)).toBe(UNKNOWN);
    // ...while an output no job declares stays genuinely absent.
    expect(evaluate("needs.beta.outputs.nope", contexts)).toBeNull();
    expect(evaluate("needs.alpha.outputs.nope", contexts)).toBeNull();
  });

  it("drops a pin that is not a context path", () => {
    const contexts = buildContexts(parseWorkflow(GATED), {
      event: "push",
      inputs: {},
      pinned: { secrets: "x", "": "y" },
    });
    expect(evaluate("secrets.DEPLOY_KEY", contexts)).toBe(UNKNOWN);
  });

  it("shrinks the unresolved list as paths get pinned", () => {
    const model = parseWorkflow(GATED);
    expect(
      unresolvedPaths(model, {
        event: "push",
        inputs: {},
        pinned: { "secrets.DEPLOY_KEY": "abc" },
      }),
    ).toEqual(["needs.deploy.outputs.url"]);
  });
});

describe("trigger filters", () => {
  const FILTERED = [
    "on:",
    "  push:",
    "    branches: [main, 'release/*']",
    "    tags: ['v*']",
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: build",
  ].join("\n");

  it("fires for a ref the filters accept", () => {
    const model = parseWorkflow(FILTERED);
    for (const ref of ["refs/heads/main", "refs/heads/release/1", "refs/tags/v1.0"]) {
      expect(triggerFires(model, { event: "push", ref, inputs: {} }).matches).toBe(true);
    }
  });

  it("does not fire for a ref no filter accepts", () => {
    const model = parseWorkflow(FILTERED);
    const result = triggerFires(model, { event: "push", ref: "refs/heads/topic", inputs: {} });
    expect(result.matches).toBe(false);
    expect(result.reason).toContain("branches:");
  });

  it("skips every job when the trigger would not fire", () => {
    const model = parseWorkflow(FILTERED);
    const result = simulateJobs(model, {
      event: "push",
      ref: "refs/heads/topic",
      inputs: {},
    });
    expect(result.get("build")?.state).toBe("skipped");
    expect(result.get("build")?.reason).toContain("does not fire");
    // The job's steps go with it.
    expect(result.get("build")?.steps).toEqual(["skipped"]);
  });

  it("fires for anything when the event declares no ref filters", () => {
    const model = parseWorkflow("on: workflow_dispatch\njobs:\n  a:\n");
    expect(
      triggerFires(model, { event: "workflow_dispatch", ref: "refs/heads/x", inputs: {} }).matches,
    ).toBe(true);
  });

  it("fires when no ref is being simulated at all", () => {
    expect(triggerFires(parseWorkflow(FILTERED), { event: "push", inputs: {} }).matches).toBe(true);
  });

  it("fires when the selected event is not declared by the workflow", () => {
    expect(
      triggerFires(parseWorkflow(FILTERED), { event: "schedule", ref: "refs/heads/x", inputs: {} })
        .matches,
    ).toBe(true);
  });
});
