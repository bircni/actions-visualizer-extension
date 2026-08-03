/**
 * Works out which jobs would run for a chosen event and set of inputs.
 *
 * This is what makes the preview more than a picture: pick `workflow_dispatch`,
 * flip an input, and every job whose `if:` depends on it changes state. Anything
 * that genuinely cannot be known statically (secrets, step outputs, a needed job's
 * outputs) stays `unknown` rather than being guessed at.
 */

import {
  PartialRecord,
  UNKNOWN,
  evaluateCondition,
  unresolvedReferences,
  type EvaluationContexts,
  type ExprValue,
} from "./expression/evaluate.js";
import { isTagRef, refMatchesFilters, refName, type RefFilterResult } from "./filters.js";
import type {
  EnvBlock,
  WorkflowInput,
  WorkflowJob,
  WorkflowModel,
  WorkflowTrigger,
} from "./model.js";

/** Whether a job or step would run for the simulated event. */
export type JobState = "run" | "skipped" | "unknown";

/** The event and inputs currently being simulated. */
export type Simulation = {
  /**
   * Selected event name, or undefined to simulate nothing in particular.
   * Explicitly nullable because the controller clears it when a trigger disappears.
   */
  event?: string | undefined;
  /** `github.ref` to evaluate against. */
  ref?: string | undefined;
  /** Values for `inputs.*`, keyed by input name. */
  inputs: Record<string, string | boolean | number>;
  /**
   * Values the user pinned for context paths the preview cannot resolve, keyed by
   * full path (`secrets.TOKEN`, `needs.build.outputs.sha`).
   */
  pinned?: Record<string, string>;
};

export type JobSimulation = {
  state: JobState;
  /** Why the job is in this state, shown as a tooltip. */
  reason?: string;
  /** State of each of the job's steps, in declaration order. */
  steps: JobState[];
};

/** A ref the user can pick for the simulated event, derived from the `on:` filters. */
export type RefChoice = { label: string; ref: string };

/** A `*` in a branch or tag filter becomes a plausible concrete segment. */
function concreteRef(pattern: string): string {
  return pattern.replaceAll("**", "x").replaceAll("*", "x");
}

/**
 * Refs worth offering for an event: every branch and tag filter it declares.
 * A `*` in a filter is replaced with a plausible concrete segment.
 */
export function refChoicesFor(trigger: WorkflowTrigger | undefined): RefChoice[] {
  if (!trigger) {
    return [];
  }
  const choices: RefChoice[] = [];
  for (const branch of trigger.branches) {
    choices.push({ label: concreteRef(branch), ref: `refs/heads/${concreteRef(branch)}` });
  }
  for (const tag of trigger.tags) {
    choices.push({ label: concreteRef(tag), ref: `refs/tags/${concreteRef(tag)}` });
  }
  if (choices.length === 0) {
    choices.push({ label: "main", ref: "refs/heads/main" });
  }
  return choices;
}

/** The inputs declared by the selected event, if it declares any. */
export function inputsFor(model: WorkflowModel, event: string | undefined): WorkflowInput[] {
  if (event == null) {
    return [];
  }
  return model.triggers.find((trigger) => trigger.event === event)?.inputs ?? [];
}

/** The default value simulation starts an input at. */
export function defaultInputValue(input: WorkflowInput): string | boolean | number {
  if (input.default !== undefined) {
    return input.default;
  }
  if (input.type === "boolean") {
    return false;
  }
  if (input.type === "number") {
    return 0;
  }
  return input.options?.[0] ?? "";
}

/** Fills in defaults for any input the user has not set. */
export function withInputDefaults(
  model: WorkflowModel,
  simulation: Simulation,
): Record<string, string | boolean | number> {
  const resolved: Record<string, string | boolean | number> = {};
  for (const input of inputsFor(model, simulation.event)) {
    const provided = simulation.inputs[input.name];
    resolved[input.name] = provided ?? defaultInputValue(input);
  }
  return resolved;
}

/**
 * Resolves an `env:` block into context values.
 *
 * A value containing `${{ }}` is only known once the run is under way, so it
 * becomes UNKNOWN rather than the literal template text.
 */
function resolveEnv(...blocks: (EnvBlock | undefined)[]): Record<string, ExprValue> {
  const resolved: Record<string, ExprValue> = {};
  for (const block of blocks) {
    for (const [key, value] of Object.entries(block ?? {})) {
      resolved[key] = value.includes("${{") ? UNKNOWN : value;
    }
  }
  return resolved;
}

/**
 * Which contexts GitHub makes available where.
 *
 * A job-level `if:` can only see `github`, `needs`, `vars` and `inputs`. A
 * step-level `if:` additionally sees `env`, `matrix`, `job`, `runner`, `steps`
 * and `strategy`. Modelling that is what stops `env.FOO` in a job `if:` from
 * quietly evaluating against a value the runner would never have supplied.
 */
type ConditionScope = "job" | "step";

/** Contexts a job-level `if:` may reference, per GitHub's availability table. */
export const JOB_CONTEXTS = ["github", "needs", "vars", "inputs"] as const;

/**
 * What a playthrough has established so far, fed back in so conditions can be
 * decided against a real run rather than against unknowns.
 */
export type RunFacts = {
  /** Jobs that have finished, with the outputs they produced. */
  jobs: Record<string, { result: string; outputs: Record<string, string> }>;
  /** Steps already decided in the job being evaluated, keyed by their `id:`. */
  steps: Record<string, { outcome: string; outputs: Record<string, string> }>;
};

export type ContextOptions = {
  scope: ConditionScope;
  /** The job the condition belongs to, for `env` and `needs` shaping. */
  job?: WorkflowJob;
  /** Facts from a playthrough. Without it every runtime value stays unknown. */
  run?: RunFacts;
};

/**
 * Builds the expression contexts for the simulation.
 *
 * `github` is a {@link PartialRecord} on purpose: a property we did not model is
 * unknown, not absent, so `github.sha == 'x'` stays undecided instead of resolving
 * to false. `inputs` is a plain object because we know every declared input, so a
 * reference to an undeclared one really is absent.
 */
export function buildContexts(
  model: WorkflowModel,
  simulation: Simulation,
  options?: ContextOptions,
): EvaluationContexts {
  const scope = options?.scope ?? "job";
  const inputs = withInputDefaults(model, simulation);
  const github: Record<string, ExprValue> = {};
  if (simulation.event != null) {
    github["event_name"] = simulation.event;
  }
  if (simulation.ref != null) {
    github["ref"] = simulation.ref;
    github["ref_name"] = refName(simulation.ref);
    github["ref_type"] = isTagRef(simulation.ref) ? "tag" : "branch";
  }
  // `github.event.inputs` is the older spelling of `inputs` for workflow_dispatch,
  // and plenty of real workflows still use it.
  github["event"] = new PartialRecord({ inputs });

  // `needs.<job>` exposes the declared outputs: a name the job declares is unknown
  // until it runs, but a name it never declares is genuinely absent. Once a
  // playthrough has actually run the job, both become known.
  const needs: Record<string, ExprValue> = {};
  for (const job of model.jobs) {
    const finished = options?.run?.jobs[job.id];
    const outputs: Record<string, ExprValue> = {};
    for (const output of job.outputs) {
      outputs[output.name] = finished?.outputs[output.name] ?? UNKNOWN;
    }
    needs[job.id] = { outputs, result: finished?.result ?? UNKNOWN };
  }

  const contexts: EvaluationContexts = {
    github: new PartialRecord(github),
    inputs,
    needs,
    // `vars` is repository configuration we cannot see, so every lookup is unknown.
    vars: new PartialRecord({}),
    secrets: new PartialRecord({}),
  };

  if (scope === "step") {
    contexts["env"] = new PartialRecord(resolveEnv(model.env, options?.job?.env));
    contexts["runner"] = new PartialRecord({});
    contexts["strategy"] = new PartialRecord({});
    contexts["matrix"] = new PartialRecord({});

    const run = options?.run;
    if (run == null) {
      contexts["job"] = new PartialRecord({});
      contexts["steps"] = new PartialRecord({});
    } else {
      // Mid-run every step that has happened is known, and one that has not is
      // genuinely empty rather than unknown — which is what GitHub reports.
      const steps: Record<string, ExprValue> = {};
      for (const [id, entry] of Object.entries(run.steps)) {
        steps[id] = {
          outcome: entry.outcome,
          conclusion: entry.outcome,
          outputs: { ...entry.outputs },
        };
      }
      contexts["steps"] = steps;
      contexts["job"] = new PartialRecord({});
    }
  }

  applyPinned(contexts, simulation.pinned ?? {});
  return contexts;
}

/**
 * Whether the simulated event would fire at all for the simulated ref.
 *
 * A workflow filtered to `branches: [main]` does not run for `refs/heads/topic`,
 * and one filtered to `tags:` only does not run for branch pushes. Without this
 * the preview would happily show every job running for a ref that could never
 * have triggered the workflow.
 */
export function triggerFires(model: WorkflowModel, simulation: Simulation): RefFilterResult {
  const trigger = model.triggers.find((candidate) => candidate.event === simulation.event);
  if (trigger == null || simulation.ref == null) {
    return { matches: true };
  }
  // Only ref-filtered events can fail to fire on a ref basis.
  if (trigger.branches.length === 0 && trigger.tags.length === 0) {
    return { matches: true };
  }
  return refMatchesFilters(simulation.ref, { branches: trigger.branches, tags: trigger.tags });
}

/** True for a fully-known record, where a key it lacks means genuinely absent. */
function isPlainRecord(value: ExprValue | undefined): value is { [key: string]: ExprValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PartialRecord)
  );
}

/**
 * Writes `value` at `segments` inside `container`, preserving what it already
 * holds and — crucially — what kind of container it is.
 *
 * The distinction carries meaning: a plain record is fully known, so a key it
 * lacks is *absent*, while a {@link PartialRecord} is only partly modelled, so a
 * key it lacks is *unknown*. Swapping one for the other silently flips every
 * sibling of the pinned path from absent to unknown.
 */
function setPath(container: ExprValue | undefined, segments: string[], value: string): ExprValue {
  const head = segments[0];
  if (head == null) {
    return value;
  }
  const rest = segments.slice(1);

  if (container instanceof PartialRecord) {
    container.properties[head] = setPath(container.properties[head], rest, value);
    return container;
  }
  if (isPlainRecord(container)) {
    container[head] = setPath(container[head], rest, value);
    return container;
  }
  // Nothing is modelled here, so a partial record is the honest choice: the
  // siblings of whatever we pin stay unknown rather than becoming absent.
  const created = new PartialRecord({});
  created.properties[head] = setPath(undefined, rest, value);
  return created;
}

/**
 * Applies the values the user pinned for things the simulation cannot know.
 *
 * A pin is a full context path such as `secrets.TOKEN` or
 * `steps.build.outputs.sha`, so it is woven into the nested context tree. A path
 * naming only a root (`secrets` on its own) pins nothing and is ignored.
 */
function applyPinned(contexts: EvaluationContexts, pinned: Record<string, string>): void {
  for (const [path, value] of Object.entries(pinned)) {
    const segments = path.split(".").filter((segment) => segment.length > 0);
    const root = segments[0];
    if (root == null || segments.length < 2) {
      continue;
    }
    contexts[root] = setPath(contexts[root], segments.slice(1), value);
  }
}

/**
 * True when a condition opts out of the normal skip-on-dependency rule.
 *
 * GitHub skips a job whose dependency was skipped, unless its `if:` uses one of the
 * status functions, which force it to be considered regardless.
 */
function overridesDependencySkip(condition: string | undefined): boolean {
  if (condition == null) {
    return false;
  }
  return /\b(?:always|cancelled|failure)\s*\(/i.test(condition);
}

/**
 * Evaluates every job's and step's `if:` and propagates skips along `needs:` edges.
 */
export function simulateJobs(
  model: WorkflowModel,
  simulation: Simulation,
): Map<string, JobSimulation> {
  const results = new Map<string, JobSimulation>();

  const fires = triggerFires(model, simulation);
  if (!fires.matches) {
    // The event would never fire for this ref, so nothing runs.
    for (const job of model.jobs) {
      results.set(job.id, {
        state: "skipped",
        reason: `\`${simulation.event ?? "this event"}\` does not fire for this ref: ${fires.reason ?? ""}`,
        steps: job.steps.map(() => "skipped"),
      });
    }
    return results;
  }

  const jobContexts = buildContexts(model, simulation, { scope: "job" });

  // Pass 1: each job's own condition.
  for (const job of model.jobs) {
    if (job.condition == null) {
      results.set(job.id, { state: "run", steps: simulateSteps(model, simulation, job) });
      continue;
    }
    const evaluation = evaluateCondition(job.condition, jobContexts);
    const steps = simulateSteps(model, simulation, job);
    if (evaluation.error != null) {
      results.set(job.id, {
        state: "unknown",
        reason: `Could not evaluate \`if:\` — ${evaluation.error}`,
        steps,
      });
      continue;
    }
    if (evaluation.result === "true") {
      results.set(job.id, { state: "run", steps });
    } else if (evaluation.result === "false") {
      results.set(job.id, { state: "skipped", reason: "`if:` is false for this event", steps });
    } else {
      results.set(job.id, {
        state: "unknown",
        reason: "`if:` depends on something only a real run knows",
        steps,
      });
    }
  }

  // Pass 2: propagate along `needs:` until nothing changes. Job counts are small,
  // and this terminates even when the workflow contains a `needs:` cycle.
  const byId = new Map(model.jobs.map((job) => [job.id, job]));
  let changed = true;
  let guard = model.jobs.length + 1;
  while (changed && guard > 0) {
    changed = false;
    guard -= 1;
    for (const job of model.jobs) {
      const current = results.get(job.id);
      if (
        current == null ||
        current.state === "skipped" ||
        overridesDependencySkip(job.condition)
      ) {
        continue;
      }
      for (const need of job.needs) {
        // A `needs:` target that does not exist means the job can never run.
        if (!byId.has(need)) {
          continue;
        }
        const upstream = results.get(need);
        if (upstream?.state === "skipped") {
          results.set(job.id, {
            ...current,
            state: "skipped",
            reason: `\`${need}\` is skipped, so this job is too`,
          });
          changed = true;
          break;
        }
        if (upstream?.state === "unknown" && current.state === "run") {
          results.set(job.id, {
            ...current,
            state: "unknown",
            reason: `depends on \`${need}\`, which may not run`,
          });
          changed = true;
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Evaluates each step's `if:`.
 *
 * Steps get a wider set of contexts than the job's own condition does — `env`,
 * `matrix`, `steps` and friends only exist once the job is running.
 */
function simulateSteps(model: WorkflowModel, simulation: Simulation, job: WorkflowJob): JobState[] {
  if (job.steps.length === 0) {
    return [];
  }
  const contexts = buildContexts(model, simulation, { scope: "step", job });
  return job.steps.map((step) => {
    if (step.condition == null) {
      return "run";
    }
    const evaluation = evaluateCondition(step.condition, contexts);
    if (evaluation.result === "true") {
      return "run";
    }
    return evaluation.result === "false" ? "skipped" : "unknown";
  });
}

/**
 * Context paths the workflow references that the simulation cannot resolve.
 *
 * These are what the user can pin: every `secrets.*`, `vars.*` and step or job
 * output a condition depends on. Returned sorted so the UI order is stable.
 */
export function unresolvedPaths(model: WorkflowModel, simulation: Simulation): string[] {
  const contexts = buildContexts(model, simulation, { scope: "step" });
  const paths = new Set<string>();

  const collect = (condition: string | undefined): void => {
    if (condition == null) {
      return;
    }
    for (const path of unresolvedReferences(condition, contexts)) {
      paths.add(path);
    }
  };

  for (const job of model.jobs) {
    collect(job.condition);
    for (const step of job.steps) {
      collect(step.condition);
    }
  }
  return [...paths].toSorted();
}
