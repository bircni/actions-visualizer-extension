import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../workflow/parse.js";
import {
  newPlaythrough,
  replay,
  type Playthrough,
  type StepDecision,
  type StepOutcome,
} from "../workflow/playthrough.js";
import type { Simulation } from "../workflow/simulate.js";
import type { WorkflowModel } from "../workflow/model.js";

const PUSH: Simulation = { event: "push", ref: "refs/heads/main", inputs: {} };

function decide(
  jobId: string,
  stepIndex: number,
  outcome: StepOutcome,
  outputs: Record<string, string> = {},
): StepDecision {
  return { jobId, stepIndex, outcome, outputs };
}

function run(model: WorkflowModel, decisions: StepDecision[], extra: Partial<Playthrough> = {}) {
  return replay(model, PUSH, { ...newPlaythrough(), decisions, ...extra });
}

/** Compact view of a job: its state plus each step's state. */
function shape(model: WorkflowModel, decisions: StepDecision[], extra: Partial<Playthrough> = {}) {
  const result = run(model, decisions, extra);
  const jobs: Record<string, { state: string; steps: string[] }> = {};
  for (const [id, job] of result.jobs) {
    jobs[id] = { state: job.state, steps: job.steps.map((step) => step.state) };
  }
  return jobs;
}

const FAILURE_PATHS = parseWorkflow(
  [
    "on: push",
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: compile",
    "        run: make",
    "      - name: notify",
    "        if: failure()",
    "        run: echo failed",
    "      - name: cleanup",
    "        if: always()",
    "        run: echo bye",
  ].join("\n"),
);

describe("replay cursor", () => {
  it("starts at the first step of the first job", () => {
    const result = run(FAILURE_PATHS, []);
    expect(result.cursor).toMatchObject({ jobId: "build", stepIndex: 0, stepName: "compile" });
    expect(result.done).toBe(false);
    expect(result.jobs.get("build")?.steps[0]?.state).toBe("current");
  });

  it("advances as decisions are made", () => {
    const result = run(FAILURE_PATHS, [decide("build", 0, "success")]);
    // `notify` is `if: failure()`, so with a healthy job the cursor skips past it.
    expect(result.cursor).toMatchObject({ stepIndex: 2, stepName: "cleanup" });
  });

  it("is undefined once everything is decided", () => {
    const result = run(FAILURE_PATHS, [
      decide("build", 0, "success"),
      decide("build", 2, "success"),
    ]);
    expect(result.cursor).toBeUndefined();
    expect(result.done).toBe(true);
  });

  it("counts progress against the steps in scope", () => {
    expect(run(FAILURE_PATHS, []).progress).toEqual({ decided: 0, total: 3 });
    expect(run(FAILURE_PATHS, [decide("build", 0, "success")]).progress.decided).toBe(1);
  });
});

describe("replay failure semantics", () => {
  it("fails the job when a step fails", () => {
    const result = run(FAILURE_PATHS, [
      decide("build", 0, "failure"),
      decide("build", 1, "success"),
      decide("build", 2, "success"),
    ]);
    expect(result.jobs.get("build")?.state).toBe("failure");
  });

  it("runs an `if: failure()` step only after a failure", () => {
    // Healthy: the notify step is skipped.
    expect(shape(FAILURE_PATHS, [decide("build", 0, "success")])["build"]?.steps[1]).toBe(
      "skipped",
    );
    // Failed: it becomes the next thing to decide.
    const failed = run(FAILURE_PATHS, [decide("build", 0, "failure")]);
    expect(failed.cursor).toMatchObject({ stepIndex: 1, stepName: "notify" });
  });

  it("runs an `if: always()` step whatever happened", () => {
    const failed = run(FAILURE_PATHS, [
      decide("build", 0, "failure"),
      decide("build", 1, "success"),
    ]);
    expect(failed.cursor).toMatchObject({ stepIndex: 2, stepName: "cleanup" });
  });

  it("skips an unconditional step once the job has failed", () => {
    const model = parseWorkflow(
      ["on: push", "jobs:", "  a:", "    steps:", "      - run: one", "      - run: two"].join(
        "\n",
      ),
    );
    const result = shape(model, [decide("a", 0, "failure")]);
    expect(result["a"]?.steps).toEqual(["failure", "skipped"]);
    expect(result["a"]?.state).toBe("failure");
  });

  it("does not fail the job for a continue-on-error step", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  a:",
        "    steps:",
        "      - run: flaky",
        "        continue-on-error: true",
        "      - run: after",
      ].join("\n"),
    );
    const result = shape(model, [decide("a", 0, "failure"), decide("a", 1, "success")]);
    // The step failed, but the job carried on and succeeded.
    expect(result["a"]?.steps).toEqual(["failure", "success"]);
    expect(result["a"]?.state).toBe("success");
  });
});

describe("replay across jobs", () => {
  const CHAIN = parseWorkflow(
    [
      "on: push",
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: make",
      "  test:",
      "    needs: build",
      "    steps:",
      "      - run: npm test",
      "  report:",
      "    needs: build",
      "    if: always()",
      "    steps:",
      "      - run: echo report",
    ].join("\n"),
  );

  it("moves to the next job once one finishes", () => {
    const result = run(CHAIN, [decide("build", 0, "success")]);
    expect(result.cursor?.jobId).toBe("test");
    expect(result.jobs.get("build")?.state).toBe("success");
  });

  it("skips a dependent job when its dependency fails", () => {
    const result = run(CHAIN, [decide("build", 0, "failure")]);
    expect(result.jobs.get("test")?.state).toBe("skipped");
    expect(result.jobs.get("test")?.reason).toContain("failed");
    // `report` opts back in with `always()`, so it still runs.
    expect(result.cursor?.jobId).toBe("report");
  });

  it("leaves jobs after the cursor pending", () => {
    const result = run(CHAIN, []);
    expect(result.jobs.get("test")?.state).toBe("pending");
    expect(result.jobs.get("report")?.state).toBe("pending");
  });

  it("carries a job's outputs to the job that needs them", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  build:",
        "    outputs:",
        "      version: ${{ steps.meta.outputs.version }}",
        "    steps:",
        "      - id: meta",
        '        run: echo "version=2" >> $GITHUB_OUTPUT',
        "  ship:",
        "    needs: build",
        "    if: needs.build.outputs.version == '2'",
        "    steps:",
        "      - run: echo ship",
      ].join("\n"),
    );

    const shipped = run(model, [decide("build", 0, "success", { version: "2" })]);
    expect(shipped.cursor?.jobId).toBe("ship");

    const notShipped = run(model, [decide("build", 0, "success", { version: "9" })]);
    expect(notShipped.jobs.get("ship")?.state).toBe("skipped");
  });

  it("lets a step read an earlier step's output in the same job", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  a:",
        "    steps:",
        "      - id: check",
        '        run: echo "ready=yes" >> $GITHUB_OUTPUT',
        "      - run: echo go",
        "        if: steps.check.outputs.ready == 'yes'",
      ].join("\n"),
    );
    const ready = run(model, [decide("a", 0, "success", { ready: "yes" })]);
    expect(ready.cursor?.stepIndex).toBe(1);

    const notReady = run(model, [decide("a", 0, "success", { ready: "no" })]);
    expect(notReady.cursor).toBeUndefined();
    expect(notReady.jobs.get("a")?.steps[1]?.state).toBe("skipped");
  });
});

describe("replay controls", () => {
  it("skips the rest of a job on request", () => {
    const result = shape(FAILURE_PATHS, [], { skippedJobs: ["build"] });
    expect(result["build"]?.steps).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("walks only the job in scope", () => {
    const model = parseWorkflow(
      "on: push\njobs:\n  a:\n    steps:\n      - run: one\n  b:\n    steps:\n      - run: two\n",
    );
    const result = replay(model, PUSH, { ...newPlaythrough("b"), decisions: [] });
    expect(result.cursor?.jobId).toBe("b");
    expect(result.jobs.get("a")?.reason).toContain("not part of this playthrough");
    expect(result.progress.total).toBe(1);
  });

  it("undoes by dropping the last decision", () => {
    const decisions = [decide("build", 0, "success"), decide("build", 2, "success")];
    const full = run(FAILURE_PATHS, decisions);
    expect(full.done).toBe(true);

    const undone = run(FAILURE_PATHS, decisions.slice(0, -1));
    // Dropping the last decision returns exactly to the previous position.
    expect(undone.cursor).toMatchObject({ stepIndex: 2 });
    expect(shape(FAILURE_PATHS, decisions.slice(0, -1))).toEqual(
      shape(FAILURE_PATHS, [decide("build", 0, "success")]),
    );
  });

  it("is deterministic for the same decisions", () => {
    const decisions = [decide("build", 0, "failure"), decide("build", 1, "success")];
    expect(shape(FAILURE_PATHS, decisions)).toEqual(shape(FAILURE_PATHS, decisions));
  });
});

describe("replay edge cases", () => {
  it("skips everything when the event would not fire for the ref", () => {
    const model = parseWorkflow(
      "on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: one\n",
    );
    const result = replay(
      model,
      { event: "push", ref: "refs/heads/topic", inputs: {} },
      newPlaythrough(),
    );
    expect(result.jobs.get("a")?.state).toBe("skipped");
    expect(result.cursor).toBeUndefined();
  });

  it("treats an undecidable condition as something to decide", () => {
    const model = parseWorkflow(
      "on: push\njobs:\n  a:\n    steps:\n      - run: one\n        if: secrets.X != ''\n",
    );
    // We cannot know, so the user gets asked rather than the walk stopping dead.
    expect(run(model, []).cursor?.stepIndex).toBe(0);
  });

  it("offers the output names it discovered at the cursor", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  a:",
        "    steps:",
        "      - id: meta",
        '        run: echo "version=1" >> $GITHUB_OUTPUT',
      ].join("\n"),
    );
    expect(run(model, []).cursor?.outputNames).toEqual(["version"]);
  });

  it("handles a workflow with no jobs", () => {
    const result = run(parseWorkflow("on: push\n"), []);
    expect(result.jobs.size).toBe(0);
    expect(result.done).toBe(true);
    expect(result.progress).toEqual({ decided: 0, total: 0 });
  });

  it("still walks a workflow whose jobs form a needs cycle", () => {
    const model = parseWorkflow(
      "on: push\njobs:\n  a:\n    needs: b\n    steps:\n      - run: one\n  b:\n    needs: a\n    steps:\n      - run: two\n",
    );
    // Order is undefined for a cycle, but it must terminate and offer something.
    const result = run(model, []);
    expect(result.jobs.size).toBe(2);
    expect(result.cursor).toBeDefined();
  });
});
