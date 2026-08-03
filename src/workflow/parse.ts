/**
 * Parses workflow YAML into a {@link WorkflowModel}.
 *
 * Uses the `yaml` document API rather than a plain `parse` so every job and step
 * keeps the source offset of its key, which lets the graph reveal the matching
 * line in the editor when a node is clicked.
 *
 * The parser is deliberately forgiving: anything it does not understand becomes a
 * diagnostic, never a thrown error. A workflow that is half-written while the user
 * types should still render whatever jobs are already valid.
 */

import { isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from "yaml";
import type {
  SourceRange,
  WorkflowDiagnostic,
  WorkflowInput,
  WorkflowJob,
  WorkflowMatrix,
  WorkflowModel,
  WorkflowStep,
  WorkflowTrigger,
} from "./model.js";

/** Cap on statically expanded matrix combinations reported in the model. */
const MAX_MATRIX_COMBINATIONS = 1000;
/** Longest `run:` prefix used as a fallback step name. */
const RUN_NAME_MAX_LENGTH = 60;

function rangeOf(node: unknown): SourceRange | undefined {
  if (node == null || typeof node !== "object" || !("range" in node)) {
    return undefined;
  }
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || typeof range[0] !== "number" || typeof range[1] !== "number") {
    return undefined;
  }
  return { start: range[0], end: range[1] };
}

/** Items of a map as key/value pairs with string keys, skipping anything else. */
function mapEntries(map: YAMLMap): { key: string; keyNode: Node; value: unknown }[] {
  const entries: { key: string; keyNode: Node; value: unknown }[] = [];
  for (const item of map.items) {
    const keyNode = item.key;
    if (!isScalar(keyNode) || typeof keyNode.value !== "string") {
      continue;
    }
    entries.push({ key: keyNode.value, keyNode, value: item.value });
  }
  return entries;
}

/** Plain JS value for a YAML node, or the value itself when it is already plain. */
function toPlain(value: unknown): unknown {
  if (isScalar(value)) {
    return value.value;
  }
  if (isSeq(value)) {
    return value.items.map(toPlain);
  }
  if (isMap(value)) {
    const result: Record<string, unknown> = {};
    for (const entry of mapEntries(value)) {
      result[entry.key] = toPlain(entry.value);
    }
    return result;
  }
  return value;
}

/** A scalar coerced to a display string, or undefined for anything non-scalar. */
function asString(value: unknown): string | undefined {
  const plain = toPlain(value);
  if (typeof plain === "string") {
    return plain;
  }
  if (typeof plain === "number" || typeof plain === "boolean") {
    return String(plain);
  }
  return undefined;
}

/** A scalar or sequence of scalars flattened to a string array. */
function asStringArray(value: unknown): string[] {
  const plain = toPlain(value);
  if (typeof plain === "string") {
    return [plain];
  }
  if (Array.isArray(plain)) {
    return plain.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/** `runs-on` accepts a string, an array of labels, or a `{ group, labels }` map. */
function describeRunsOn(value: unknown): string | undefined {
  const plain = toPlain(value);
  if (typeof plain === "string") {
    return plain;
  }
  if (Array.isArray(plain)) {
    const labels = plain.filter((entry): entry is string => typeof entry === "string");
    return labels.length > 0 ? labels.join(", ") : undefined;
  }
  if (plain != null && typeof plain === "object") {
    const record = plain as Record<string, unknown>;
    const labels = asStringArray(record["labels"]);
    const group = typeof record["group"] === "string" ? record["group"] : undefined;
    const parts = [group, ...labels].filter((part): part is string => part != null);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/** `environment` accepts a string or a `{ name, url }` map. */
function describeEnvironment(value: unknown): string | undefined {
  const plain = toPlain(value);
  if (typeof plain === "string") {
    return plain;
  }
  if (plain != null && typeof plain === "object") {
    const name = (plain as Record<string, unknown>)["name"];
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/** Qualifiers shown under a trigger node, e.g. `branches: main` or `cron: 0 0 * * *`. */
function describeTriggerDetails(value: unknown): string[] {
  const plain = toPlain(value);
  if (plain == null || typeof plain !== "object") {
    return [];
  }
  // `schedule:` is a sequence of `{ cron: ... }` maps rather than a map of filters.
  if (Array.isArray(plain)) {
    const crons = (plain as unknown[])
      .map((item) =>
        item != null && typeof item === "object" ? (item as Record<string, unknown>)["cron"] : item,
      )
      .filter((cron): cron is string => typeof cron === "string");
    return crons.length > 0 ? [`cron: ${crons.join(", ")}`] : [];
  }
  const details: string[] = [];
  for (const [key, entry] of Object.entries(plain as Record<string, unknown>)) {
    if (Array.isArray(entry)) {
      // `schedule` is a list of `{ cron: ... }` maps rather than a list of scalars.
      const scalars = entry.filter(
        (item): item is string | number => typeof item === "string" || typeof item === "number",
      );
      if (scalars.length > 0) {
        details.push(`${key}: ${scalars.join(", ")}`);
        continue;
      }
      const crons = entry
        .map((item) =>
          item != null && typeof item === "object"
            ? (item as Record<string, unknown>)["cron"]
            : undefined,
        )
        .filter((cron): cron is string => typeof cron === "string");
      if (crons.length > 0) {
        details.push(`cron: ${crons.join(", ")}`);
      }
      continue;
    }
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      details.push(`${key}: ${String(entry)}`);
      continue;
    }
    if (entry != null && typeof entry === "object") {
      details.push(key);
    }
  }
  return details;
}

const INPUT_TYPES = new Set(["string", "boolean", "number", "choice", "environment"]);

/** Coerces a declared default to the input's type, so simulation starts realistic. */
function coerceInputDefault(
  value: unknown,
  type: WorkflowInput["type"],
): string | boolean | number | undefined {
  if (value == null) {
    return undefined;
  }
  if (type === "boolean") {
    return value === true || value === "true";
  }
  if (type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** Parses `workflow_dispatch.inputs` / `workflow_call.inputs`. */
function parseInputs(value: unknown): WorkflowInput[] {
  if (!isMap(value)) {
    return [];
  }
  const inputs: WorkflowInput[] = [];
  for (const entry of mapEntries(value)) {
    const spec = toPlain(entry.value);
    if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
      inputs.push({ name: entry.key, type: "string", required: false });
      continue;
    }
    const record = spec as Record<string, unknown>;
    const declaredType = record["type"];
    const type =
      typeof declaredType === "string" && INPUT_TYPES.has(declaredType)
        ? (declaredType as WorkflowInput["type"])
        : "string";
    const description = record["description"];
    const options = Array.isArray(record["options"]) ? record["options"].map(String) : undefined;
    const fallback = coerceInputDefault(record["default"], type);

    inputs.push({
      name: entry.key,
      type,
      required: record["required"] === true,
      ...(typeof description === "string" ? { description } : {}),
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(options == null ? {} : { options }),
    });
  }
  return inputs;
}

function emptyTrigger(event: string, range?: SourceRange): WorkflowTrigger {
  const trigger: WorkflowTrigger = { event, details: [], branches: [], tags: [], inputs: [] };
  return range ? { ...trigger, range } : trigger;
}

/**
 * `on:` accepts a scalar (`on: push`), a sequence (`on: [push, pull_request]`)
 * or a map with per-event filters.
 */
function parseTriggers(value: unknown): WorkflowTrigger[] {
  if (isScalar(value) && typeof value.value === "string") {
    return [emptyTrigger(value.value, rangeOf(value))];
  }
  if (isSeq(value)) {
    const triggers: WorkflowTrigger[] = [];
    for (const item of value.items) {
      const event = asString(item);
      if (event != null) {
        triggers.push(emptyTrigger(event, rangeOf(item)));
      }
    }
    return triggers;
  }
  if (isMap(value)) {
    const triggers: WorkflowTrigger[] = [];
    for (const entry of mapEntries(value)) {
      const base = emptyTrigger(entry.key, rangeOf(entry.keyNode));
      const details = describeTriggerDetails(entry.value);
      const branches = isMap(entry.value) ? asStringArray(entry.value.get("branches", true)) : [];
      const tags = isMap(entry.value) ? asStringArray(entry.value.get("tags", true)) : [];
      const inputs = isMap(entry.value) ? parseInputs(entry.value.get("inputs", true)) : [];
      triggers.push({ ...base, details, branches, tags, inputs });
    }
    return triggers;
  }
  return [];
}

/** Summarises `strategy.matrix` without expanding it. */
function parseMatrix(value: unknown): WorkflowMatrix | undefined {
  const plain = toPlain(value);
  // `matrix: ${{ fromJSON(...) }}` builds the matrix at run time; there is nothing
  // to count, but the job is still a matrix job and should say so.
  if (typeof plain === "string") {
    return { axes: [], isDynamic: true };
  }
  if (plain == null || typeof plain !== "object" || Array.isArray(plain)) {
    return undefined;
  }
  const record = plain as Record<string, unknown>;
  const axes: { key: string; values: string[] }[] = [];
  let isDynamic = false;

  for (const [key, entry] of Object.entries(record)) {
    if (key === "include" || key === "exclude") {
      // include/exclude change the combination count in ways we do not model.
      isDynamic = true;
      continue;
    }
    if (typeof entry === "string") {
      // A bare string here is almost always a `${{ ... }}` expression.
      isDynamic = true;
      axes.push({ key, values: [entry] });
      continue;
    }
    if (!Array.isArray(entry)) {
      isDynamic = true;
      continue;
    }
    axes.push({ key, values: entry.map((item) => String(toPlain(item))) });
  }

  if (axes.length === 0 && !isDynamic) {
    return undefined;
  }

  const combinations = axes.reduce((total, axis) => total * Math.max(axis.values.length, 1), 1);
  const matrix: WorkflowMatrix = { axes, isDynamic };
  if (!isDynamic && axes.length > 0 && combinations <= MAX_MATRIX_COMBINATIONS) {
    return { ...matrix, combinations };
  }
  return matrix;
}

/** Fallback display name for a `run:` step: its first non-empty line, truncated. */
function runStepName(run: string): string {
  const firstLine =
    run
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "run";
  return firstLine.length > RUN_NAME_MAX_LENGTH
    ? `${firstLine.slice(0, RUN_NAME_MAX_LENGTH - 1)}…`
    : firstLine;
}

function parseStep(node: unknown, index: number): WorkflowStep {
  const range = rangeOf(node);
  if (!isMap(node)) {
    const unknownStep: WorkflowStep = {
      name: `step ${String(index + 1)}`,
      isRun: false,
      continueOnError: false,
    };
    return range ? { ...unknownStep, range } : unknownStep;
  }

  const map = node;
  const explicitName = asString(map.get("name", true));
  const uses = asString(map.get("uses", true));
  const run = asString(map.get("run", true));
  const condition = asString(map.get("if", true));
  const continueOnError = toPlain(map.get("continue-on-error", true)) === true;

  let name = explicitName;
  name ??= uses;
  if (name == null && run != null) {
    name = runStepName(run);
  }
  name ??= `step ${String(index + 1)}`;

  const step: WorkflowStep = { name, isRun: run != null, continueOnError };
  return {
    ...step,
    ...(uses == null ? {} : { uses }),
    ...(condition == null ? {} : { condition }),
    ...(range == null ? {} : { range }),
  };
}

function parseSteps(value: unknown): WorkflowStep[] {
  if (!isSeq(value)) {
    return [];
  }
  return value.items.map((item, index) => parseStep(item, index));
}

function parseJob(id: string, keyNode: Node, value: unknown): WorkflowJob {
  const range = rangeOf(keyNode);
  const base: WorkflowJob = { id, name: id, needs: [], steps: [] };
  if (!isMap(value)) {
    return range ? { ...base, range } : base;
  }

  const map = value;
  const name = asString(map.get("name", true));
  const needs = asStringArray(map.get("needs", true));
  const condition = asString(map.get("if", true));
  const runsOn = describeRunsOn(map.get("runs-on", true));
  const environment = describeEnvironment(map.get("environment", true));
  const uses = asString(map.get("uses", true));
  const strategy = map.get("strategy", true);
  const matrix = isMap(strategy) ? parseMatrix(strategy.get("matrix", true)) : undefined;

  return {
    id,
    name: name ?? id,
    needs,
    steps: parseSteps(map.get("steps", true)),
    ...(condition == null ? {} : { condition }),
    ...(runsOn == null ? {} : { runsOn }),
    ...(environment == null ? {} : { environment }),
    ...(uses == null ? {} : { uses }),
    ...(matrix == null ? {} : { matrix }),
    ...(range == null ? {} : { range }),
  };
}

/**
 * Parses workflow YAML. Never throws: syntax errors become `fatalError`, and
 * anything merely unexpected becomes a diagnostic.
 */
export function parseWorkflow(text: string): WorkflowModel {
  const diagnostics: WorkflowDiagnostic[] = [];
  let doc;
  try {
    doc = parseDocument(text, { keepSourceTokens: false });
  } catch (error) {
    return {
      triggers: [],
      jobs: [],
      diagnostics,
      fatalError: error instanceof Error ? error.message : "Could not parse the workflow file.",
    };
  }

  const syntaxError = doc.errors[0];
  if (syntaxError) {
    return { triggers: [], jobs: [], diagnostics, fatalError: syntaxError.message };
  }
  for (const warning of doc.warnings) {
    diagnostics.push({ severity: "warning", message: warning.message });
  }

  const root = doc.contents;
  if (!isMap(root)) {
    return {
      triggers: [],
      jobs: [],
      diagnostics,
      fatalError: "The workflow file must be a YAML mapping with `on:` and `jobs:` keys.",
    };
  }

  const rootMap = root;
  const name = asString(rootMap.get("name", true));
  // YAML 1.1 parsers turn `on:` into the boolean `true`; the 1.2 core schema used
  // here keeps it a string, but accept both so hand-written files always work.
  const triggers = parseTriggers(rootMap.get("on", true) ?? rootMap.get(true, true));

  const jobsNode = rootMap.get("jobs", true);
  const jobs: WorkflowJob[] = [];
  if (isMap(jobsNode)) {
    for (const entry of mapEntries(jobsNode)) {
      jobs.push(parseJob(entry.key, entry.keyNode, entry.value));
    }
  } else if (jobsNode == null) {
    diagnostics.push({ severity: "warning", message: "The workflow declares no jobs." });
  } else {
    diagnostics.push({ severity: "error", message: "`jobs:` must be a mapping of job ids." });
  }

  return { ...(name == null ? {} : { name }), triggers, jobs, diagnostics };
}
