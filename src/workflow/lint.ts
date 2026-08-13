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
import { workflowOutputJobs } from "./outputs.js";
import type { SourceRange, WorkflowModel } from "./model.js";

export type LintSeverity = "error" | "warning" | "information";

export type LintCode =
  | "missing-needs"
  | "self-needs"
  | "duplicate-needs"
  | "invalid-job-context"
  | "always-false-condition"
  | "condition-parse-error"
  | "unconsumed-outputs";

type LintFix =
  | { kind: "remove-need"; jobId: string; itemIndexes: number[]; safe: boolean }
  | { kind: "remove-condition"; jobId: string }
  | { kind: "remove-outputs"; jobId: string };

export type LintFinding = {
  code: LintCode;
  severity: LintSeverity;
  message: string;
  fix?: LintFix;
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
  const exportedOutputJobs = workflowOutputJobs(model);
  for (const job of model.jobs) {
    for (const need of job.needs) {
      neededBy.set(need, [...(neededBy.get(need) ?? []), job.id]);
    }
  }

  for (const job of model.jobs) {
    // A `needs:` target that does not exist makes the workflow invalid outright.
    for (const [itemIndex, need] of job.needs.entries()) {
      if (!jobIds.has(need)) {
        findings.push({
          code: "missing-needs",
          severity: "error",
          message: `Job \`${job.id}\` needs \`${need}\`, which this workflow does not define.`,
          fix: { kind: "remove-need", jobId: job.id, itemIndexes: [itemIndex], safe: false },
          ...(job.source?.needs?.items[itemIndex]?.range == null
            ? job.range == null
              ? {}
              : { range: job.range }
            : { range: job.source.needs.items[itemIndex].range }),
        });
      }
    }

    // A job listing itself can never start.
    if (job.needs.includes(job.id)) {
      const itemIndexes = job.needs.flatMap((need, index) => (need === job.id ? [index] : []));
      const itemIndex = itemIndexes[0] ?? 0;
      const itemRange = job.source?.needs?.items[itemIndex]?.range;
      findings.push({
        code: "self-needs",
        severity: "error",
        message: `Job \`${job.id}\` lists itself in \`needs:\`, so it can never run.`,
        fix: {
          kind: "remove-need",
          jobId: job.id,
          itemIndexes,
          safe: true,
        },
        ...(itemRange == null
          ? job.range == null
            ? {}
            : { range: job.range }
          : { range: itemRange }),
      });
    }

    // Duplicate `needs:` entries are harmless but always a mistake.
    const seen = new Set<string>();
    for (const [itemIndex, need] of job.needs.entries()) {
      if (seen.has(need)) {
        findings.push({
          code: "duplicate-needs",
          severity: "warning",
          message: `Job \`${job.id}\` lists \`${need}\` in \`needs:\` more than once.`,
          fix: { kind: "remove-need", jobId: job.id, itemIndexes: [itemIndex], safe: true },
          ...(job.source?.needs?.items[itemIndex]?.range == null
            ? job.range == null
              ? {}
              : { range: job.range }
            : { range: job.source.needs.items[itemIndex].range }),
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
            code: "invalid-job-context",
            severity: "warning",
            message:
              `Job \`${job.id}\` uses \`${root}\` in its \`if:\`, but a job-level condition ` +
              `only has access to ${[...JOB_CONTEXTS].map((name) => `\`${name}\``).join(", ")}.`,
            ...(job.source?.condition == null
              ? job.range == null
                ? {}
                : { range: job.range }
              : { range: job.source.condition }),
          });
        }
      }

      // A condition that is constant regardless of context is dead weight.
      const constant = evaluateCondition(job.condition, {});
      if (constant.error == null && constant.result === "false") {
        findings.push({
          code: "always-false-condition",
          severity: "warning",
          message: `Job \`${job.id}\` has an \`if:\` that is always false, so it never runs.`,
          fix: { kind: "remove-condition", jobId: job.id },
          ...(job.source?.condition == null
            ? job.range == null
              ? {}
              : { range: job.range }
            : { range: job.source.condition }),
        });
      }
    }

    // An output declared but never read by a dependent job is usually a leftover.
    const readers = neededBy.get(job.id) ?? [];
    if (job.outputs.length > 0 && readers.length === 0 && !exportedOutputJobs.has(job.id)) {
      findings.push({
        code: "unconsumed-outputs",
        severity: "information",
        message: `Job \`${job.id}\` declares outputs, but no other job needs it.`,
        fix: { kind: "remove-outputs", jobId: job.id },
        ...(job.source?.outputs == null
          ? job.range == null
            ? {}
            : { range: job.range }
          : { range: job.source.outputs }),
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
          code: "condition-parse-error",
          severity: "warning",
          message: `Job \`${job.id}\` has an \`if:\` that does not parse: ${evaluation.error}`,
          ...(job.source?.condition == null
            ? job.range == null
              ? {}
              : { range: job.range }
            : { range: job.source.condition }),
        });
      }
    }
  }

  return findings;
}
