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

function callFunction(name: string, args: ExprValue[]): ExprValue {
  switch (name) {
    // In a static preview we show the graph for a successful run.
    case "success":
      return true;
    case "always":
      return true;
    case "failure":
      return false;
    case "cancelled":
      return false;
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

function evaluateNode(node: ExpressionNode, contexts: EvaluationContexts): ExprValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "context":
      return Object.prototype.hasOwnProperty.call(contexts, node.name)
        ? (contexts[node.name] ?? null)
        : UNKNOWN;
    case "property":
      return readProperty(evaluateNode(node.target, contexts), node.name);
    case "index":
      return readIndex(evaluateNode(node.target, contexts), evaluateNode(node.index, contexts));
    case "filter":
      return applyFilter(evaluateNode(node.target, contexts));
    case "call":
      return callFunction(
        node.name,
        node.args.map((argument) => evaluateNode(argument, contexts)),
      );
    case "unary": {
      const operand = toBoolean(evaluateNode(node.operand, contexts));
      return isUnknown(operand) ? UNKNOWN : !operand;
    }
    case "binary": {
      const left = evaluateNode(node.left, contexts);
      if (node.operator === "&&") {
        const truth = toBoolean(left);
        // A known-false left side decides the result even if the right is unknown.
        if (truth === false) {
          return left;
        }
        const right = evaluateNode(node.right, contexts);
        return isUnknown(truth) ? UNKNOWN : right;
      }
      if (node.operator === "||") {
        const truth = toBoolean(left);
        if (truth === true) {
          return left;
        }
        const right = evaluateNode(node.right, contexts);
        return isUnknown(truth) ? UNKNOWN : right;
      }

      const right = evaluateNode(node.right, contexts);
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
      value = evaluateNode(parseExpression(trimmed), contexts);
    } else if (template.length === 1 && template[0]?.kind === "expression") {
      value = evaluateNode(template[0].node, contexts);
    } else {
      // Mixed text and expressions produce a string, which is then tested for truth.
      let text = "";
      for (const part of template) {
        if (part.kind === "text") {
          text += part.text;
          continue;
        }
        const partValue = evaluateNode(part.node, contexts);
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

/** Evaluates a bare expression, for tests and for interpolating display strings. */
export function evaluate(source: string, contexts: EvaluationContexts): ExprValue {
  return evaluateNode(parseExpression(source), contexts);
}
