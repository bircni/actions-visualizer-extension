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
  evaluateCondition,
  type EvaluationContexts,
  type ExprValue,
} from "./expression/evaluate.js";
import type { WorkflowInput, WorkflowModel, WorkflowTrigger } from "./model.js";

/** Whether a job would run for the simulated event. */
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
};

export type JobSimulation = {
  state: JobState;
  /** Why the job is in this state, shown as a tooltip. */
  reason?: string;
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

function refName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}

/**
 * Builds the expression contexts for the simulation.
 *
 * `github` is a {@link PartialRecord} on purpose: a property we did not model is
 * unknown, not absent, so `github.sha == 'x'` stays undecided instead of resolving
 * to false. `inputs` is a plain object because we know every declared input, so a
 * reference to an undeclared one really is absent.
 */
export function buildContexts(model: WorkflowModel, simulation: Simulation): EvaluationContexts {
  const inputs = withInputDefaults(model, simulation);
  const github: Record<string, ExprValue> = {};
  if (simulation.event != null) {
    github["event_name"] = simulation.event;
  }
  if (simulation.ref != null) {
    github["ref"] = simulation.ref;
    github["ref_name"] = refName(simulation.ref);
    github["ref_type"] = simulation.ref.startsWith("refs/tags/") ? "tag" : "branch";
  }
  // `github.event.inputs` is the older spelling of `inputs` for workflow_dispatch,
  // and plenty of real workflows still use it.
  github["event"] = new PartialRecord({ inputs });

  return { github: new PartialRecord(github), inputs };
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
 * Evaluates every job's `if:` and propagates skips along `needs:` edges.
 * Returns a state per job id.
 */
export function simulateJobs(
  model: WorkflowModel,
  simulation: Simulation,
): Map<string, JobSimulation> {
  const contexts = buildContexts(model, simulation);
  const results = new Map<string, JobSimulation>();

  // Pass 1: each job's own condition.
  for (const job of model.jobs) {
    if (job.condition == null) {
      results.set(job.id, { state: "run" });
      continue;
    }
    const evaluation = evaluateCondition(job.condition, contexts);
    if (evaluation.error != null) {
      results.set(job.id, {
        state: "unknown",
        reason: `Could not evaluate \`if:\` — ${evaluation.error}`,
      });
      continue;
    }
    if (evaluation.result === "true") {
      results.set(job.id, { state: "run" });
    } else if (evaluation.result === "false") {
      results.set(job.id, { state: "skipped", reason: `\`if:\` is false for this event` });
    } else {
      results.set(job.id, {
        state: "unknown",
        reason: "`if:` depends on something only a real run knows",
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
            state: "skipped",
            reason: `\`${need}\` is skipped, so this job is too`,
          });
          changed = true;
          break;
        }
        if (upstream?.state === "unknown" && current.state === "run") {
          results.set(job.id, {
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
