/**
 * Works out which outputs a step produces, so a playthrough can ask for them by
 * name instead of making the user remember what the script writes.
 *
 * Two sources, unioned:
 *
 * 1. What the step's `run:` script *writes* — `name=value >> $GITHUB_OUTPUT` and
 *    its heredoc form.
 * 2. What the rest of the workflow *reads* — every `steps.<id>.outputs.<name>`
 *    appearing in a condition or a job's `outputs:` expression.
 *
 * Discovery is best-effort by design: it seeds the form, and the user can always
 * add a name it missed. Reading is done with the real expression parser rather
 * than a regular expression, so it cannot be fooled by a path inside a string.
 */

import { parseExpression, parseTemplate } from "./expression/parse.js";
import type { ExpressionNode } from "./expression/ast.js";
import type { WorkflowModel, WorkflowStep } from "./model.js";

/**
 * Matches `name=…` on the same line as a redirect into `$GITHUB_OUTPUT`.
 *
 * The name is nearly always inside quotes — `echo "version=1" >> $GITHUB_OUTPUT`
 * — so a quote counts as a valid character before it. Tolerates
 * `>>$GITHUB_OUTPUT`, `>> "$GITHUB_OUTPUT"`, `${GITHUB_OUTPUT}` and the
 * PowerShell `$env:GITHUB_OUTPUT`. `.` not matching a newline is what keeps the
 * name and its redirect on one line.
 */
const WRITE_PATTERN =
  /(?:^|[\s;&|("'])([A-Za-z_][\w-]*)=.*?>>\s*["']?(?:\$\{?GITHUB_OUTPUT\}?|\$env:GITHUB_OUTPUT)["']?/gm;

/**
 * Matches the heredoc form, which spans lines:
 *
 * ```sh
 * {
 *   echo 'notes<<EOF'
 *   ...
 * } >> "$GITHUB_OUTPUT"
 * ```
 */
const HEREDOC_PATTERN = /(?:^|[\s;&|("'])([A-Za-z_][\w-]*)<<[-~]?\s*['"]?[A-Za-z_]\w*/gm;

/** Output names a step's `run:` script writes. */
export function writtenOutputs(step: WorkflowStep): string[] {
  const script = step.run;
  if (script == null || script.length === 0) {
    return [];
  }

  const names = new Set<string>();
  for (const match of script.matchAll(WRITE_PATTERN)) {
    const name = match[1];
    if (name != null) {
      names.add(name);
    }
  }
  // Only look for heredocs when the script mentions the file at all, so an
  // unrelated `cat <<EOF` elsewhere is not mistaken for an output.
  if (script.includes("GITHUB_OUTPUT")) {
    for (const match of script.matchAll(HEREDOC_PATTERN)) {
      const name = match[1];
      if (name != null) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** Every `steps.<stepId>.outputs.<name>` an expression reads. */
function collectStepOutputReads(node: ExpressionNode, into: Map<string, Set<string>>): void {
  // The shape we are after is property(property(property(context steps, id), "outputs"), name).
  if (node.kind === "property") {
    const outputsNode = node.target;
    if (
      outputsNode.kind === "property" &&
      outputsNode.name === "outputs" &&
      outputsNode.target.kind === "property" &&
      outputsNode.target.target.kind === "context" &&
      outputsNode.target.target.name === "steps"
    ) {
      const stepId = outputsNode.target.name;
      const names = into.get(stepId) ?? new Set<string>();
      names.add(node.name);
      into.set(stepId, names);
      return;
    }
  }

  switch (node.kind) {
    case "property":
    case "filter":
      collectStepOutputReads(node.target, into);
      break;
    case "index":
      collectStepOutputReads(node.target, into);
      collectStepOutputReads(node.index, into);
      break;
    case "call":
      for (const argument of node.args) {
        collectStepOutputReads(argument, into);
      }
      break;
    case "unary":
      collectStepOutputReads(node.operand, into);
      break;
    case "binary":
      collectStepOutputReads(node.left, into);
      collectStepOutputReads(node.right, into);
      break;
    case "context":
    case "literal":
      break;
    default:
      break;
  }
}

/** Parses one expression or template and collects its step-output reads. */
function readExpression(source: string | undefined, into: Map<string, Set<string>>): void {
  if (source == null || source.trim().length === 0) {
    return;
  }
  try {
    const template = parseTemplate(source);
    if (template == null) {
      collectStepOutputReads(parseExpression(source), into);
      return;
    }
    for (const part of template) {
      if (part.kind === "expression") {
        collectStepOutputReads(part.node, into);
      }
    }
  } catch {
    // An expression that does not parse simply contributes no names.
  }
}

/**
 * Step output names the workflow reads anywhere, keyed by step id.
 *
 * Scans every job and step condition and every job output expression. Step ids
 * are workflow-wide here rather than per job, which slightly over-offers when two
 * jobs reuse an id — harmless, since the user is choosing from a list.
 */
export function referencedOutputs(model: WorkflowModel): Map<string, Set<string>> {
  const reads = new Map<string, Set<string>>();
  for (const job of model.jobs) {
    readExpression(job.condition, reads);
    for (const output of job.outputs) {
      readExpression(output.expression, reads);
    }
    for (const step of job.steps) {
      readExpression(step.condition, reads);
    }
  }
  return reads;
}

/**
 * Every output name worth offering for a step: what its script writes, plus what
 * the workflow reads from it. Sorted so the form order is stable.
 *
 * Takes the read map rather than the model so a caller walking every step builds
 * it once instead of rescanning the workflow per step.
 */
export function discoverStepOutputs(step: WorkflowStep, reads: Map<string, Set<string>>): string[] {
  const names = new Set(writtenOutputs(step));
  if (step.id != null) {
    for (const name of reads.get(step.id) ?? []) {
      names.add(name);
    }
  }
  return [...names].toSorted();
}
