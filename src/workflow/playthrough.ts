/**
 * Walks a workflow one step at a time, asking the user what happened.
 *
 * The state kept is *only* the ordered list of decisions the user has made. This
 * module replays them from the beginning to derive everything else: which job is
 * current, which steps ran, what every context holds. Nothing is mutated
 * incrementally.
 *
 * That is what makes undo a matter of dropping the last decision, restart a
 * matter of emptying the list, and the whole thing deterministic and testable
 * without a webview.
 */

import { evaluateCondition, type EvaluationRuntime } from "./expression/evaluate.js";
import { discoverStepOutputs, referencedOutputs } from "./outputs.js";
import { buildContexts, triggerFires, type RunFacts, type Simulation } from "./simulate.js";
import type { WorkflowJob, WorkflowModel, WorkflowStep } from "./model.js";

/** What the user says happened to a step. */
export type StepOutcome = "success" | "failure" | "skipped";

/** How a step or job stands in the walk so far. */
type RunState = "pending" | "current" | "success" | "failure" | "skipped";

export type StepDecision = {
  jobId: string;
  stepIndex: number;
  outcome: StepOutcome;
  /** Values the step produced, keyed by output name. */
  outputs: Record<string, string>;
};

export type Playthrough = {
  /** A single job to walk, or undefined for the whole workflow. */
  scope?: string | undefined;
  decisions: StepDecision[];
  /** Jobs whose remaining steps the user chose not to walk. */
  skippedJobs: string[];
};

type StepRun = { state: RunState; reason?: string };

type JobRun = {
  state: RunState;
  steps: StepRun[];
  reason?: string;
};

/** Where the user is, and what the panel should ask them for. */
type PlaythroughCursor = {
  jobId: string;
  jobName: string;
  stepIndex: number;
  stepName: string;
  /** Output names worth offering a field for. */
  outputNames: string[];
};

export type PlaythroughRun = {
  jobs: Map<string, JobRun>;
  /** Undefined once there is nothing left to decide. */
  cursor?: PlaythroughCursor;
  progress: { decided: number; total: number };
  done: boolean;
};

/** An empty playthrough, which is where every run starts. */
export function newPlaythrough(scope?: string): Playthrough {
  return { ...(scope == null ? {} : { scope }), decisions: [], skippedJobs: [] };
}

/**
 * Jobs in dependency order.
 *
 * Kahn's algorithm, with anything left over (a `needs:` cycle) appended in
 * declaration order so a malformed workflow still walks instead of hanging.
 */
function orderJobs(jobs: WorkflowJob[]): WorkflowJob[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const remaining = new Map(
    jobs.map((job) => [job.id, job.needs.filter((need) => byId.has(need)).length]),
  );
  const ordered: WorkflowJob[] = [];
  const done = new Set<string>();

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const job of jobs) {
      if (done.has(job.id) || (remaining.get(job.id) ?? 0) > 0) {
        continue;
      }
      ordered.push(job);
      done.add(job.id);
      progressed = true;
      for (const other of jobs) {
        if (other.needs.includes(job.id)) {
          remaining.set(other.id, (remaining.get(other.id) ?? 1) - 1);
        }
      }
    }
  }
  for (const job of jobs) {
    if (!done.has(job.id)) {
      ordered.push(job);
    }
  }
  return ordered;
}

/** A condition that opts out of being skipped when something upstream failed. */
function overridesFailure(condition: string | undefined): boolean {
  return condition != null && /\b(?:always|cancelled|failure)\s*\(/i.test(condition);
}

/** The status a job starts with, given how the jobs it needs turned out. */
function statusFromNeeds(
  job: WorkflowJob,
  results: Map<string, RunState>,
): EvaluationRuntime["status"] {
  for (const need of job.needs) {
    const result = results.get(need);
    if (result === "failure") {
      return "failure";
    }
  }
  return "success";
}

/** Decision for a given step, if the user has made one. */
function decisionFor(
  playthrough: Playthrough,
  jobId: string,
  stepIndex: number,
): StepDecision | undefined {
  return playthrough.decisions.find(
    (decision) => decision.jobId === jobId && decision.stepIndex === stepIndex,
  );
}

/** All steps of a job marked the same way, for a job that never starts. */
function allSteps(job: WorkflowJob, state: RunState): StepRun[] {
  return job.steps.map(() => ({ state }));
}

/**
 * Replays the decisions into a full picture of the run.
 *
 * The walk stops at the first step that would run and has no decision yet — that
 * step becomes the cursor, and everything after it stays pending, because what
 * happens next genuinely depends on the answer.
 */
export function replay(
  model: WorkflowModel,
  simulation: Simulation,
  playthrough: Playthrough,
): PlaythroughRun {
  const jobs = new Map<string, JobRun>();
  const results = new Map<string, RunState>();
  const reads = referencedOutputs(model);
  const facts: RunFacts = { jobs: {}, steps: {} };

  let cursor: PlaythroughCursor | undefined;
  let total = 0;

  const inScope = (job: WorkflowJob): boolean =>
    playthrough.scope == null || job.id === playthrough.scope;

  // An event that would not fire means there is nothing to walk at all.
  const fires = triggerFires(model, simulation);

  for (const job of orderJobs(model.jobs)) {
    if (inScope(job)) {
      total += job.steps.length;
    }

    // Once the cursor is set, everything after it is genuinely unknown.
    if (cursor != null) {
      jobs.set(job.id, { state: "pending", steps: allSteps(job, "pending") });
      continue;
    }

    if (!inScope(job)) {
      jobs.set(job.id, {
        state: "pending",
        steps: allSteps(job, "pending"),
        reason: "not part of this playthrough",
      });
      continue;
    }

    if (!fires.matches) {
      jobs.set(job.id, {
        state: "skipped",
        steps: allSteps(job, "skipped"),
        reason: `\`${simulation.event ?? "this event"}\` does not fire for this ref`,
      });
      results.set(job.id, "skipped");
      continue;
    }

    const skip = jobSkipReason(job, model, simulation, results, playthrough);
    if (skip != null) {
      jobs.set(job.id, { state: "skipped", steps: allSteps(job, "skipped"), reason: skip });
      results.set(job.id, "skipped");
      continue;
    }

    const walk = walkJob(job, model, simulation, playthrough, facts);
    jobs.set(job.id, walk.run);
    if (walk.cursorStep != null) {
      const step = job.steps[walk.cursorStep];
      cursor = {
        jobId: job.id,
        jobName: job.name,
        stepIndex: walk.cursorStep,
        stepName: step?.name ?? `step ${String(walk.cursorStep + 1)}`,
        outputNames: step == null ? [] : discoverStepOutputs(step, reads),
      };
      continue;
    }

    results.set(job.id, walk.run.state);
    facts.jobs[job.id] = {
      result: walk.run.state === "failure" ? "failure" : walk.run.state,
      outputs: jobOutputs(job, walk.stepFacts),
    };
  }

  return {
    jobs,
    ...(cursor == null ? {} : { cursor }),
    progress: { decided: playthrough.decisions.length, total },
    done: cursor == null,
  };
}

/** Why a job never starts, or undefined when it does. */
function jobSkipReason(
  job: WorkflowJob,
  model: WorkflowModel,
  simulation: Simulation,
  results: Map<string, RunState>,
  playthrough: Playthrough,
): string | undefined {
  // A job whose dependency was skipped or failed does not run, unless its
  // condition explicitly opts back in with a status function.
  if (!overridesFailure(job.condition)) {
    for (const need of job.needs) {
      const result = results.get(need);
      if (result === "skipped") {
        return `\`${need}\` was skipped`;
      }
      if (result === "failure") {
        return `\`${need}\` failed`;
      }
    }
  }

  if (job.condition == null) {
    return undefined;
  }

  const contexts = buildContexts(model, simulation, {
    scope: "job",
    job,
    run: { jobs: jobFactsFor(playthrough, results), steps: {} },
  });
  const evaluation = evaluateCondition(job.condition, contexts, {
    status: statusFromNeeds(job, results),
  });
  // An undecidable condition is treated as running, so the user gets to decide
  // rather than having the walk stop dead on something we cannot know.
  return evaluation.result === "false" ? "`if:` is false for this run" : undefined;
}

/** The job facts a job-level condition can see. */
function jobFactsFor(playthrough: Playthrough, results: Map<string, RunState>): RunFacts["jobs"] {
  const jobs: RunFacts["jobs"] = {};
  for (const [id, state] of results) {
    if (state === "success" || state === "failure" || state === "skipped") {
      jobs[id] = { result: state, outputs: outputsFromDecisions(playthrough, id) };
    }
  }
  return jobs;
}

/** Everything the decided steps of a job produced, flattened. */
function outputsFromDecisions(playthrough: Playthrough, jobId: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const decision of playthrough.decisions) {
    if (decision.jobId === jobId) {
      Object.assign(outputs, decision.outputs);
    }
  }
  return outputs;
}

/** Resolves a job's declared `outputs:` from the steps that produced them. */
function jobOutputs(job: WorkflowJob, stepFacts: RunFacts["steps"]): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const output of job.outputs) {
    // The common shape is `name: ${{ steps.<id>.outputs.<name> }}`; anything the
    // step actually produced under that name is the value.
    for (const step of Object.values(stepFacts)) {
      const value = step.outputs[output.name];
      if (value != null) {
        outputs[output.name] = value;
      }
    }
  }
  return outputs;
}

/** Walks one job's steps, stopping at the first that needs a decision. */
function walkJob(
  job: WorkflowJob,
  model: WorkflowModel,
  simulation: Simulation,
  playthrough: Playthrough,
  facts: RunFacts,
): { run: JobRun; cursorStep?: number; stepFacts: RunFacts["steps"] } {
  const steps: StepRun[] = [];
  const stepFacts: RunFacts["steps"] = {};
  const skipRest = playthrough.skippedJobs.includes(job.id);
  // A job's own status starts clean, even when it only ran because `if: always()`
  // opted it back in after a dependency failed. `statusFromNeeds` decides whether
  // the job runs at all; it does not carry into the steps inside it.
  let status: EvaluationRuntime["status"] = "success";
  let cursorStep: number | undefined;

  for (const [index, step] of job.steps.entries()) {
    if (cursorStep != null) {
      steps.push({ state: "pending" });
      continue;
    }

    if (!stepRuns(step, model, simulation, job, facts, stepFacts, status)) {
      steps.push({ state: "skipped", reason: "`if:` is false at this point in the run" });
      continue;
    }

    const decision = decisionFor(playthrough, job.id, index);
    if (decision == null) {
      if (skipRest) {
        steps.push({ state: "skipped", reason: "you skipped the rest of this job" });
        continue;
      }
      cursorStep = index;
      steps.push({ state: "current" });
      continue;
    }

    steps.push({ state: decision.outcome });
    if (step.id != null) {
      stepFacts[step.id] = { outcome: decision.outcome, outputs: decision.outputs };
    }
    // `continue-on-error` is what keeps a failed step from failing its job — the
    // flag has been parsed since the first version and never consumed until now.
    if (decision.outcome === "failure" && !step.continueOnError) {
      status = "failure";
    }
  }

  const state: RunState =
    cursorStep == null ? (status === "failure" ? "failure" : "success") : "current";
  return {
    run: { state, steps },
    ...(cursorStep == null ? {} : { cursorStep }),
    stepFacts,
  };
}

/** Whether a step's `if:` lets it run at this point in the walk. */
function stepRuns(
  step: WorkflowStep,
  model: WorkflowModel,
  simulation: Simulation,
  job: WorkflowJob,
  facts: RunFacts,
  stepFacts: RunFacts["steps"],
  status: EvaluationRuntime["status"],
): boolean {
  if (step.condition == null) {
    // Without a condition, a step runs only while the job is still healthy.
    return status === "success" || status === "cancelled";
  }
  const contexts = buildContexts(model, simulation, {
    scope: "step",
    job,
    run: { jobs: facts.jobs, steps: stepFacts },
  });
  const evaluation = evaluateCondition(step.condition, contexts, { status });
  // Undecidable means the user should get to choose, so it counts as running.
  return evaluation.result !== "false";
}
