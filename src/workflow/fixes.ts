/**
 * Builds targeted text edits for workflow lint findings.
 *
 * This module stays independent of VS Code so YAML-shape handling and Fix All
 * behaviour can be tested without an extension host.
 */

import type { LintFinding } from "./lint.js";
import type { SourceRange, WorkflowJob, WorkflowModel } from "./model.js";

export type WorkflowTextEdit = { range: SourceRange; replacement: string };

export type WorkflowFixAction = {
  title: string;
  preferred: boolean;
  edits: WorkflowTextEdit[];
};

function lineRange(text: string, range: SourceRange): SourceRange {
  const before = text.lastIndexOf("\n", Math.max(0, range.start - 1));
  const start = before === -1 ? 0 : before + 1;
  if (range.end > 0 && text[range.end - 1] === "\n") {
    return { start, end: range.end };
  }
  const newline = text.indexOf("\n", range.end);
  return { start, end: newline === -1 ? text.length : newline + 1 };
}

function jobFor(model: WorkflowModel, jobId: string): WorkflowJob | undefined {
  return model.jobs.find((job) => job.id === jobId);
}

function separatorRange(text: string, start: number, end: number): SourceRange | undefined {
  const offset = text.indexOf(",", start);
  if (offset === -1 || offset >= end) {
    return undefined;
  }
  const afterComma = text.slice(offset + 1, end);
  return { start: offset, end: /^\s*$/.test(afterComma) ? end : offset + 1 };
}

/** Removes one job property, respecting block and `{ ... }` map styles. */
function removeProperty(text: string, job: WorkflowJob, range: SourceRange): WorkflowTextEdit[] {
  const flow = job.source?.flow;
  if (flow == null) {
    return [{ range: lineRange(text, range), replacement: "" }];
  }
  const properties = flow.properties;
  const index = properties.findIndex(
    (property) => property.start === range.start && property.end === range.end,
  );
  if (index === -1) {
    return [];
  }
  if (properties.length === 1) {
    const trailingSeparator = separatorRange(text, range.end, flow.range.end);
    return [
      { range, replacement: "" },
      ...(trailingSeparator == null ? [] : [{ range: trailingSeparator, replacement: "" }]),
    ];
  }

  if (index < properties.length - 1) {
    const next = properties[index + 1];
    const separator = next == null ? undefined : separatorRange(text, range.end, next.start);
    return [
      { range, replacement: "" },
      ...(separator == null ? [] : [{ range: separator, replacement: "" }]),
    ];
  }

  const previous = properties[index - 1];
  const separator = previous == null ? undefined : separatorRange(text, previous.end, range.start);
  return [
    ...(separator == null ? [] : [{ range: separator, replacement: "" }]),
    { range, replacement: "" },
  ];
}

/** Removes flow-sequence scalars and only the commas made redundant by them. */
function removeFlowItems(
  text: string,
  job: WorkflowJob,
  removedIndexes: ReadonlySet<number>,
): WorkflowTextEdit[] {
  const items = job.source?.needs?.items ?? [];
  const edits: WorkflowTextEdit[] = [];
  const removed = [...removedIndexes].toSorted((left, right) => left - right);
  for (const index of removed) {
    const range = items[index]?.range;
    if (range != null) {
      edits.push({ range, replacement: "" });
    }
  }

  // For each contiguous removed run, delete the commas after its items when a
  // retained item follows. For a trailing run, delete the comma before the run
  // and those between its items. Whitespace and comments are left verbatim.
  let runStart = 0;
  while (runStart < removed.length) {
    let runEnd = runStart;
    while (removed[runEnd + 1] === (removed[runEnd] ?? -1) + 1) {
      runEnd += 1;
    }
    const first = removed[runStart];
    const last = removed[runEnd];
    if (first == null || last == null) {
      break;
    }
    if (last + 1 < items.length) {
      for (let index = first; index <= last; index += 1) {
        const left = items[index]?.range;
        const right = items[index + 1]?.range;
        const comma =
          left == null || right == null ? undefined : separatorRange(text, left.end, right.start);
        if (comma != null) {
          edits.push({ range: comma, replacement: "" });
        }
      }
    } else {
      const previous = items[first - 1]?.range;
      const current = items[first]?.range;
      const leadingComma =
        previous == null || current == null
          ? undefined
          : separatorRange(text, previous.end, current.start);
      if (leadingComma != null) {
        edits.push({ range: leadingComma, replacement: "" });
      }
      for (let index = first; index < last; index += 1) {
        const left = items[index]?.range;
        const right = items[index + 1]?.range;
        const comma =
          left == null || right == null ? undefined : separatorRange(text, left.end, right.start);
        if (comma != null) {
          edits.push({ range: comma, replacement: "" });
        }
      }
    }
    runStart = runEnd + 1;
  }
  return edits;
}

/** Removes selected `needs:` items while retaining the surrounding YAML style. */
function removeNeedsItems(
  text: string,
  job: WorkflowJob,
  removedIndexes: ReadonlySet<number>,
): WorkflowTextEdit[] {
  const source = job.source?.needs;
  if (source == null || removedIndexes.size === 0) {
    return [];
  }

  const retainedIndexes = job.needs
    .map((_, index) => index)
    .filter((index) => !removedIndexes.has(index));
  if (retainedIndexes.length === 0) {
    return removeProperty(text, job, source.range);
  }

  const valueText = text.slice(source.valueRange.start, source.valueRange.end);
  if (valueText.trimStart().startsWith("[")) {
    return removeFlowItems(text, job, removedIndexes);
  }

  // A block sequence has one dependency per line. Removing the complete line
  // also removes its dash and any inline comment belonging to that item.
  const edits: WorkflowTextEdit[] = [];
  for (const index of removedIndexes) {
    const range = source.items[index]?.range;
    if (range != null) {
      edits.push({ range: lineRange(text, range), replacement: "" });
    }
  }
  return edits;
}

function titleFor(finding: LintFinding, job: WorkflowJob): string {
  if (finding.fix?.kind === "remove-need") {
    const dependency = job.needs[finding.fix.itemIndexes[0] ?? -1] ?? "dependency";
    if (finding.code === "duplicate-needs") {
      return `Remove duplicate dependency '${dependency}'`;
    }
    if (finding.code === "self-needs") {
      return `Remove self-dependency '${dependency}'`;
    }
    return `Remove undefined dependency '${dependency}'`;
  }
  if (finding.fix?.kind === "remove-condition") {
    return "Remove always-false condition (job will run)";
  }
  return "Remove unconsumed outputs block";
}

export function fixesForFinding(
  text: string,
  model: WorkflowModel,
  finding: LintFinding,
): WorkflowFixAction[] {
  const fix = finding.fix;
  if (fix == null) {
    return [];
  }
  const job = jobFor(model, fix.jobId);
  if (job == null) {
    return [];
  }

  let edits: WorkflowTextEdit[] = [];
  if (fix.kind === "remove-need") {
    edits = removeNeedsItems(text, job, new Set(fix.itemIndexes));
  } else {
    const range = fix.kind === "remove-condition" ? job.source?.condition : job.source?.outputs;
    if (range != null) {
      edits = removeProperty(text, job, range);
    }
  }
  return edits.length === 0
    ? []
    : [{ title: titleFor(finding, job), preferred: fix.kind === "remove-need" && fix.safe, edits }];
}

/** One non-overlapping edit set for every safe dependency cleanup in the document. */
export function fixAllSafe(
  text: string,
  model: WorkflowModel,
  findings: readonly LintFinding[],
): WorkflowTextEdit[] {
  const indexesByJob = new Map<string, Set<number>>();
  for (const finding of findings) {
    if (finding.fix?.kind !== "remove-need" || !finding.fix.safe) {
      continue;
    }
    const indexes = indexesByJob.get(finding.fix.jobId) ?? new Set<number>();
    for (const itemIndex of finding.fix.itemIndexes) {
      indexes.add(itemIndex);
    }
    indexesByJob.set(finding.fix.jobId, indexes);
  }

  const edits: WorkflowTextEdit[] = [];
  for (const [jobId, indexes] of indexesByJob) {
    const job = jobFor(model, jobId);
    if (job != null) {
      edits.push(...removeNeedsItems(text, job, indexes));
    }
  }
  return edits;
}
