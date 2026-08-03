/**
 * Evaluator for the GitHub Actions expression language.
 *
 * Two things make this more than a toy interpreter:
 *
 * 1. **GitHub's coercion rules.** Comparing different types casts both sides to a
 *    number; string equality is case-insensitive; `&&` and `||` return an operand
 *    rather than a boolean.
 * 2. **Unknown propagation.** A static preview cannot know `secrets`, `steps` or a
 *    job's outputs. Those evaluate to {@link UNKNOWN}, which spreads through every
 *    operation except a short-circuit that is already decided. That is what lets the
 *    graph say "this job may or may not run" instead of guessing.
 */

import { parseExpression, parseTemplate } from "./parse.js";
import { ExpressionSyntaxError, type ExpressionNode } from "./ast.js";

/** A value the evaluator could not determine statically. */
export const UNKNOWN = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

export type ExprValue =
  | string
  | number
  | boolean
  | null
  | ExprValue[]
  | { [key: string]: ExprValue }
  | PartialRecord
  | Unknown;

/**
 * An object whose listed properties are known but whose other properties are not.
 * Used for contexts like `github`, where we know `event_name` but not `sha`.
 */
export class PartialRecord {
  constructor(public readonly properties: Record<string, ExprValue>) {}
}

export type EvaluationContexts = Record<string, ExprValue>;

/**
 * What the enclosing job has done so far, which is what the status functions
 * report on.
 *
 * A static preview has no run to look at, so it assumes the success path — that
 * is what {@link DEFAULT_RUNTIME} encodes, and it keeps `if: success()` true and
 * `if: failure()` false exactly as before. A playthrough supplies a real status,
 * at which point those conditions start meaning something.
 */
export type EvaluationRuntime = {
  status: "success" | "failure" | "cancelled";
};

const DEFAULT_RUNTIME: EvaluationRuntime = { status: "success" };

function isUnknown(value: ExprValue): value is Unknown {
  return value === UNKNOWN;
}

function isPlainObject(value: ExprValue): value is { [key: string]: ExprValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PartialRecord)
  );
}

/** GitHub's truthiness: only `false`, `0`, `NaN`, `''` and `null` are falsy. */
export function toBoolean(value: ExprValue): boolean | Unknown {
  if (isUnknown(value)) {
    return UNKNOWN;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null) {
    return false;
  }
  if (typeof value === "number") {
    return value !== 0 && !Number.isNaN(value);
  }
  if (typeof value === "string") {
    return value !== "";
  }
  return true;
}

/** GitHub casts to a number when comparing values of different types. */
function toNumber(value: ExprValue): number {
  if (value === null) {
    return 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return 0;
    }
    return Number(trimmed);
  }
  return Number.NaN;
}

/** The string form used by `format()`, `join()` and string interpolation. */
export function toDisplayString(value: ExprValue): string {
  if (isUnknown(value)) {
    return "";
  }
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof PartialRecord) {
    return "Object";
  }
  return Array.isArray(value) ? "Array" : "Object";
}

function looseEquals(left: ExprValue, right: ExprValue): boolean {
  if (typeof left === "string" && typeof right === "string") {
    // GitHub ignores case when comparing strings.
    return left.toLowerCase() === right.toLowerCase();
  }
  if (typeof left === typeof right && (typeof left === "number" || typeof left === "boolean")) {
    return left === right;
  }
  if (left === null && right === null) {
    return true;
  }
  const leftIsCollection = typeof left === "object" && left !== null;
  const rightIsCollection = typeof right === "object" && right !== null;
  if (leftIsCollection || rightIsCollection) {
    // Objects and arrays compare by reference.
    return left === right;
  }
  const a = toNumber(left);
  const b = toNumber(right);
  return Number.isNaN(a) || Number.isNaN(b) ? false : a === b;
}

function compare(operator: "<" | "<=" | ">" | ">=", left: ExprValue, right: ExprValue): boolean {
  const a = toNumber(left);
  const b = toNumber(right);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return false;
  }
  switch (operator) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return false;
  }
}

function readProperty(target: ExprValue, name: string): ExprValue {
  if (isUnknown(target)) {
    return UNKNOWN;
  }
  if (target instanceof PartialRecord) {
    // A property we did not model is unknown, not absent.
    return Object.prototype.hasOwnProperty.call(target.properties, name)
      ? (target.properties[name] ?? null)
      : UNKNOWN;
  }
  if (Array.isArray(target)) {
    // `array.prop` collects the property across the array, like an object filter.
    const collected: ExprValue[] = [];
    for (const item of target) {
      const value = readProperty(item, name);
      if (isUnknown(value)) {
        return UNKNOWN;
      }
      if (value !== null) {
        collected.push(value);
      }
    }
    return collected;
  }
  if (isPlainObject(target)) {
    return Object.prototype.hasOwnProperty.call(target, name) ? (target[name] ?? null) : null;
  }
  return null;
}

function readIndex(target: ExprValue, index: ExprValue): ExprValue {
  if (isUnknown(target) || isUnknown(index)) {
    return UNKNOWN;
  }
  if (Array.isArray(target)) {
    const position = toNumber(index);
    if (!Number.isInteger(position) || position < 0 || position >= target.length) {
      return null;
    }
    return target[position] ?? null;
  }
  return readProperty(target, toDisplayString(index));
}

function applyFilter(target: ExprValue): ExprValue {
  if (isUnknown(target)) {
    return UNKNOWN;
  }
  if (Array.isArray(target)) {
    return target;
  }
  if (target instanceof PartialRecord) {
    return UNKNOWN;
  }
  if (isPlainObject(target)) {
    return Object.values(target);
  }
  return [];
}

function callFunction(name: string, args: ExprValue[], runtime: EvaluationRuntime): ExprValue {
  switch (name) {
    // The status functions read the job's progress, not the expression's inputs,
    // so they are decided before the UNKNOWN-argument check below.
    case "success":
      return runtime.status === "success";
    case "failure":
      return runtime.status === "failure";
    case "cancelled":
      return runtime.status === "cancelled";
    case "always":
      return true;
    // Depends on the working tree, so it can never be known here.
    case "hashfiles":
      return UNKNOWN;
    default:
      break;
  }

  if (args.some((argument) => isUnknown(argument))) {
    return UNKNOWN;
  }

  switch (name) {
    case "contains": {
      const [haystack, needle] = args;
      if (haystack === undefined || needle === undefined) {
        return false;
      }
      if (Array.isArray(haystack)) {
        return haystack.some((item) => looseEquals(item, needle));
      }
      return toDisplayString(haystack)
        .toLowerCase()
        .includes(toDisplayString(needle).toLowerCase());
    }
    case "startswith": {
      const [value, prefix] = args;
      return toDisplayString(value ?? null)
        .toLowerCase()
        .startsWith(toDisplayString(prefix ?? null).toLowerCase());
    }
    case "endswith": {
      const [value, suffix] = args;
      return toDisplayString(value ?? null)
        .toLowerCase()
        .endsWith(toDisplayString(suffix ?? null).toLowerCase());
    }
    case "format": {
      const [template, ...rest] = args;
      // `{0}` interpolates an argument; `{{` and `}}` are literal braces.
      return toDisplayString(template ?? null).replaceAll(
        /\{\{|\}\}|\{(\d+)\}/g,
        (match, digits: string | undefined) => {
          if (match === "{{") {
            return "{";
          }
          if (match === "}}") {
            return "}";
          }
          const value = rest[Number(digits)];
          return value === undefined ? match : toDisplayString(value);
        },
      );
    }
    case "join": {
      const [value, separator] = args;
      const glue = separator === undefined ? "," : toDisplayString(separator);
      if (Array.isArray(value)) {
        return value.map((item) => toDisplayString(item)).join(glue);
      }
      return toDisplayString(value ?? null);
    }
    case "tojson": {
      const [value] = args;
      if (value instanceof PartialRecord) {
        return UNKNOWN;
      }
      return JSON.stringify(value, null, 2);
    }
    case "fromjson": {
      const [value] = args;
      try {
        return JSON.parse(toDisplayString(value ?? null)) as ExprValue;
      } catch {
        return UNKNOWN;
      }
    }
    default:
      // An unrecognised function is unknown rather than an error, so a workflow
      // using something we have not modelled still renders.
      return UNKNOWN;
  }
}

function evaluateNode(
  node: ExpressionNode,
  contexts: EvaluationContexts,
  runtime: EvaluationRuntime,
): ExprValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "context":
      return Object.prototype.hasOwnProperty.call(contexts, node.name)
        ? (contexts[node.name] ?? null)
        : UNKNOWN;
    case "property":
      return readProperty(evaluateNode(node.target, contexts, runtime), node.name);
    case "index":
      return readIndex(
        evaluateNode(node.target, contexts, runtime),
        evaluateNode(node.index, contexts, runtime),
      );
    case "filter":
      return applyFilter(evaluateNode(node.target, contexts, runtime));
    case "call":
      return callFunction(
        node.name,
        node.args.map((argument) => evaluateNode(argument, contexts, runtime)),
        runtime,
      );
    case "unary": {
      const operand = toBoolean(evaluateNode(node.operand, contexts, runtime));
      return isUnknown(operand) ? UNKNOWN : !operand;
    }
    case "binary": {
      const left = evaluateNode(node.left, contexts, runtime);
      if (node.operator === "&&") {
        const truth = toBoolean(left);
        // A known-false left side decides the result even if the right is unknown.
        if (truth === false) {
          return left;
        }
        const right = evaluateNode(node.right, contexts, runtime);
        return isUnknown(truth) ? UNKNOWN : right;
      }
      if (node.operator === "||") {
        const truth = toBoolean(left);
        if (truth === true) {
          return left;
        }
        const right = evaluateNode(node.right, contexts, runtime);
        return isUnknown(truth) ? UNKNOWN : right;
      }

      const right = evaluateNode(node.right, contexts, runtime);
      if (isUnknown(left) || isUnknown(right)) {
        return UNKNOWN;
      }
      if (node.operator === "==") {
        return looseEquals(left, right);
      }
      if (node.operator === "!=") {
        return !looseEquals(left, right);
      }
      return compare(node.operator, left, right);
    }
    default:
      return UNKNOWN;
  }
}

/** Outcome of evaluating a condition: definitely yes, definitely no, or undecidable. */
type ConditionResult = "true" | "false" | "unknown";

export type ConditionEvaluation = {
  result: ConditionResult;
  /** Set when the expression could not be parsed. */
  error?: string;
};

/**
 * Evaluates a job or step `if:` value.
 *
 * GitHub allows the `${{ }}` wrapper to be omitted in `if:`, and also allows a
 * value that mixes literal text with expressions. Both forms are handled here.
 */
export function evaluateCondition(
  condition: string,
  contexts: EvaluationContexts,
  runtime: EvaluationRuntime = DEFAULT_RUNTIME,
): ConditionEvaluation {
  const trimmed = condition.trim();
  if (trimmed === "") {
    return { result: "true" };
  }

  try {
    let value: ExprValue;
    const template = parseTemplate(trimmed);
    if (template == null) {
      // No `${{ }}` at all: the whole value is the expression.
      value = evaluateNode(parseExpression(trimmed), contexts, runtime);
    } else if (template.length === 1 && template[0]?.kind === "expression") {
      value = evaluateNode(template[0].node, contexts, runtime);
    } else {
      // Mixed text and expressions produce a string, which is then tested for truth.
      let text = "";
      for (const part of template) {
        if (part.kind === "text") {
          text += part.text;
          continue;
        }
        const partValue = evaluateNode(part.node, contexts, runtime);
        if (isUnknown(partValue)) {
          return { result: "unknown" };
        }
        text += toDisplayString(partValue);
      }
      value = text;
    }

    const truth = toBoolean(value);
    if (isUnknown(truth)) {
      return { result: "unknown" };
    }
    return { result: truth ? "true" : "false" };
  } catch (error) {
    return {
      result: "unknown",
      error:
        error instanceof ExpressionSyntaxError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Could not evaluate the expression.",
    };
  }
}

/** The dotted path a node spells out, or undefined when it is not a plain path. */
function pathOf(node: ExpressionNode): string | undefined {
  if (node.kind === "context") {
    return node.name;
  }
  if (node.kind === "property") {
    const parent = pathOf(node.target);
    return parent == null ? undefined : `${parent}.${node.name}`;
  }
  if (node.kind === "index" && node.index.kind === "literal") {
    const parent = pathOf(node.target);
    const key = node.index.value;
    return parent == null || typeof key !== "string" ? undefined : `${parent}.${key}`;
  }
  return undefined;
}

/**
 * Context paths in an expression that the given contexts cannot resolve.
 *
 * Walks the AST collecting every dotted path whose value comes back UNKNOWN — the
 * `secrets.TOKEN` and `steps.build.outputs.sha` a workflow's conditions depend on.
 * These are exactly the values worth offering the user to pin, and reporting the
 * longest resolvable path keeps the list short: `secrets.TOKEN`, not `secrets`.
 */
export function unresolvedReferences(condition: string, contexts: EvaluationContexts): string[] {
  const found = new Set<string>();

  const walk = (node: ExpressionNode): void => {
    const path = pathOf(node);
    if (path != null) {
      if (isUnknown(evaluateNode(node, contexts, DEFAULT_RUNTIME))) {
        // Only record the full path; the parent that also reads unknown is noise.
        found.add(path);
      }
      return;
    }
    switch (node.kind) {
      case "property":
      case "filter":
        walk(node.target);
        break;
      case "index":
        walk(node.target);
        walk(node.index);
        break;
      case "call":
        for (const argument of node.args) {
          walk(argument);
        }
        break;
      case "unary":
        walk(node.operand);
        break;
      case "binary":
        walk(node.left);
        walk(node.right);
        break;
      case "context":
      case "literal":
        break;
      default:
        break;
    }
  };

  try {
    const template = parseTemplate(condition.trim());
    if (template == null) {
      walk(parseExpression(condition.trim()));
    } else {
      for (const part of template) {
        if (part.kind === "expression") {
          walk(part.node);
        }
      }
    }
  } catch {
    // A condition that does not parse has no references worth offering.
    return [];
  }

  return [...found];
}

/** Evaluates a bare expression, for tests and for interpolating display strings. */
export function evaluate(source: string, contexts: EvaluationContexts): ExprValue {
  return evaluateNode(parseExpression(source), contexts, DEFAULT_RUNTIME);
}
