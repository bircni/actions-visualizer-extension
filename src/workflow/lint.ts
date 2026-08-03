/**
 * Workflow-level checks that the YAML schema will not catch.
 *
 * These are reported as editor diagnostics rather than only in the preview, so a
 * user gets them without opening the graph at all. Everything here is decided
 * statically and conservatively: a check that cannot be sure stays quiet, because
 * a false positive in the Problems panel is worse than a missed one.
 */

import { evaluateCondition } from "./expression/evaluate.js";
import { buildContexts, JOB_CONTEXTS, type Simulation } from "./simulate.js";
import type { SourceRange, WorkflowModel } from "./model.js";

export type LintSeverity = "error" | "warning" | "information";

export type LintFinding = {
  severity: LintSeverity;
  message: string;
  /** Where to underline, when the parser captured a position. */
  range?: SourceRange;
};

/** Context roots a job-level `if:` may reference, per GitHub's availability table. */
const JOB_CONTEXT_SET = new Set<string>(JOB_CONTEXTS);
/** Roots that are never contexts, so seeing one is a typo rather than a scope error. */
const KNOWN_CONTEXTS = new Set([
  ...JOB_CONTEXTS,
  "env",
  "job",
  "jobs",
  "matrix",
  "runner",
  "secrets",
  "steps",
  "strategy",
]);

/** The context roots an expression references, ignoring function names. */
function referencedRoots(condition: string): string[] {
  const roots = new Set<string>();
  // A root is an identifier at the start of a dotted path that is not a call.
  const pattern = /(?<![.\w])([A-Za-z_]\w*)\s*\./g;
  let match = pattern.exec(condition);
  while (match != null) {
    const root = match[1];
    if (root != null) {
      roots.add(root);
    }
    match = pattern.exec(condition);
  }
  return [...roots];
}

/**
 * Checks a workflow and returns everything worth reporting.
 *
 * `simulation` is the event currently being previewed; checks that depend on it
 * (such as a condition that can never be true for the selected event) use it,
 * and the rest ignore it.
 */
export function lintWorkflow(model: WorkflowModel, simulation: Simulation): LintFinding[] {
  const findings: LintFinding[] = [];
  if (model.fatalError != null) {
    return findings;
  }

  const jobIds = new Set(model.jobs.map((job) => job.id));
  const neededBy = new Map<string, string[]>();
  for (const job of model.jobs) {
    for (const need of job.needs) {
      neededBy.set(need, [...(neededBy.get(need) ?? []), job.id]);
    }
  }

  for (const job of model.jobs) {
    // A `needs:` target that does not exist makes the workflow invalid outright.
    for (const need of job.needs) {
      if (!jobIds.has(need)) {
        findings.push({
          severity: "error",
          message: `Job \`${job.id}\` needs \`${need}\`, which this workflow does not define.`,
          ...(job.range == null ? {} : { range: job.range }),
        });
      }
    }

    // A job listing itself can never start.
    if (job.needs.includes(job.id)) {
      findings.push({
        severity: "error",
        message: `Job \`${job.id}\` lists itself in \`needs:\`, so it can never run.`,
        ...(job.range == null ? {} : { range: job.range }),
      });
    }

    // Duplicate `needs:` entries are harmless but always a mistake.
    const seen = new Set<string>();
    for (const need of job.needs) {
      if (seen.has(need)) {
        findings.push({
          severity: "warning",
          message: `Job \`${job.id}\` lists \`${need}\` in \`needs:\` more than once.`,
          ...(job.range == null ? {} : { range: job.range }),
        });
      }
      seen.add(need);
    }

    if (job.condition != null) {
      // A job-level `if:` sees fewer contexts than a step-level one does.
      for (const root of referencedRoots(job.condition)) {
        if (!KNOWN_CONTEXTS.has(root)) {
          continue;
        }
        if (!JOB_CONTEXT_SET.has(root)) {
          findings.push({
            severity: "warning",
            message:
              `Job \`${job.id}\` uses \`${root}\` in its \`if:\`, but a job-level condition ` +
              `only has access to ${[...JOB_CONTEXTS].map((name) => `\`${name}\``).join(", ")}.`,
            ...(job.range == null ? {} : { range: job.range }),
          });
        }
      }

      // A condition that is constant regardless of context is dead weight.
      const constant = evaluateCondition(job.condition, {});
      if (constant.error == null && constant.result === "false") {
        findings.push({
          severity: "warning",
          message: `Job \`${job.id}\` has an \`if:\` that is always false, so it never runs.`,
          ...(job.range == null ? {} : { range: job.range }),
        });
      }
    }

    // An output declared but never read by a dependent job is usually a leftover.
    const readers = neededBy.get(job.id) ?? [];
    if (job.outputs.length > 0 && readers.length === 0) {
      findings.push({
        severity: "information",
        message: `Job \`${job.id}\` declares outputs, but no other job needs it.`,
        ...(job.range == null ? {} : { range: job.range }),
      });
    }
  }

  // A trigger whose filters can never match the ref being previewed.
  const trigger = model.triggers.find((candidate) => candidate.event === simulation.event);
  if (trigger != null && simulation.ref != null) {
    const contexts = buildContexts(model, simulation);
    for (const job of model.jobs) {
      if (job.condition == null) {
        continue;
      }
      const evaluation = evaluateCondition(job.condition, contexts);
      if (evaluation.error != null) {
        findings.push({
          severity: "warning",
          message: `Job \`${job.id}\` has an \`if:\` that does not parse: ${evaluation.error}`,
          ...(job.range == null ? {} : { range: job.range }),
        });
      }
    }
  }

  return findings;
}
