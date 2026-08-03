import { describe, expect, it } from "vitest";
import { ExpressionSyntaxError } from "../workflow/expression/ast.js";
import {
  PartialRecord,
  UNKNOWN,
  evaluate,
  evaluateCondition,
  toBoolean,
  toDisplayString,
  type EvaluationContexts,
} from "../workflow/expression/evaluate.js";
import { parseExpression, parseTemplate } from "../workflow/expression/parse.js";

const CONTEXTS: EvaluationContexts = {
  github: new PartialRecord({
    event_name: "push",
    ref: "refs/heads/main",
    ref_name: "main",
    event: new PartialRecord({ action: "opened" }),
  }),
  inputs: { environment: "staging", deploy: true, count: 3 },
  matrix: { os: "ubuntu-latest" },
  vars: {},
};

function value(source: string): ReturnType<typeof evaluate> {
  return evaluate(source, CONTEXTS);
}

describe("lexer and parser", () => {
  it("parses literals of every kind", () => {
    expect(value("true")).toBe(true);
    expect(value("FALSE")).toBe(false);
    expect(value("null")).toBeNull();
    expect(value("42")).toBe(42);
    expect(value("-7")).toBe(-7);
    expect(value("1.5")).toBe(1.5);
    expect(value("0xff")).toBe(255);
    expect(value("1e3")).toBe(1000);
    expect(value("'hello'")).toBe("hello");
  });

  it("treats a doubled quote as an escaped quote", () => {
    expect(value("'it''s here'")).toBe("it's here");
  });

  it("honours operator precedence and grouping", () => {
    expect(value("true || false && false")).toBe(true);
    expect(value("(true || false) && false")).toBe(false);
    expect(value("1 < 2 == true")).toBe(true);
  });

  it("parses dashes inside property names", () => {
    const node = parseExpression("inputs.dry-run");
    expect(node).toEqual({
      kind: "property",
      target: { kind: "context", name: "inputs" },
      name: "dry-run",
    });
  });

  it("rejects malformed input", () => {
    expect(() => parseExpression("'unterminated")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("1 +")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("(1")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("github.")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("1 2")).toThrow(ExpressionSyntaxError);
  });
});

describe("parseTemplate", () => {
  it("returns undefined when there is no interpolation", () => {
    expect(parseTemplate("github.event_name == 'push'")).toBeUndefined();
  });

  it("splits literal text from expressions", () => {
    const parts = parseTemplate("refs/heads/${{ inputs.environment }}-x");
    expect(parts?.map((part) => part.kind)).toEqual(["text", "expression", "text"]);
  });

  it("throws on an unterminated interpolation", () => {
    expect(() => parseTemplate("${{ inputs.a")).toThrow(ExpressionSyntaxError);
  });
});

describe("context access", () => {
  it("reads known context properties", () => {
    expect(value("github.event_name")).toBe("push");
    expect(value("github.event.action")).toBe("opened");
    expect(value("inputs.environment")).toBe("staging");
  });

  it("supports index syntax", () => {
    expect(value("inputs['environment']")).toBe("staging");
    expect(value("fromJSON('[10,20]')[1]")).toBe(20);
  });

  it("returns UNKNOWN for a context we do not model", () => {
    expect(value("secrets.TOKEN")).toBe(UNKNOWN);
    expect(value("steps.build.outputs.sha")).toBe(UNKNOWN);
  });

  it("distinguishes an unmodelled property from an absent one", () => {
    // `github` is partial: a property we did not populate is unknown...
    expect(value("github.sha")).toBe(UNKNOWN);
    // ...but `inputs` is fully known, so a missing input is genuinely absent.
    expect(value("inputs.nope")).toBeNull();
  });

  it("collects values with the object filter", () => {
    expect(value('fromJSON(\'{"a":1,"b":2}\').*')).toEqual([1, 2]);
  });
});

describe("GitHub coercion rules", () => {
  it("compares strings case-insensitively", () => {
    expect(value("'MAIN' == 'main'")).toBe(true);
    expect(value("'main' != 'MAIN'")).toBe(false);
  });

  it("casts across types when comparing", () => {
    expect(value("'' == 0")).toBe(true);
    expect(value("null == 0")).toBe(true);
    expect(value("true == 1")).toBe(true);
    expect(value("'3' == 3")).toBe(true);
    // A string that is not a number never equals a number.
    expect(value("'abc' == 0")).toBe(false);
  });

  it("orders by numeric value", () => {
    expect(value("2 > 1")).toBe(true);
    expect(value("'10' >= 10")).toBe(true);
    expect(value("'abc' < 5")).toBe(false);
  });

  it("returns an operand rather than a boolean from && and ||", () => {
    expect(value("'a' && 'b'")).toBe("b");
    expect(value("'' || 'fallback'")).toBe("fallback");
    expect(value("'first' || 'second'")).toBe("first");
  });

  it("applies GitHub truthiness", () => {
    expect(toBoolean("")).toBe(false);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(null)).toBe(false);
    expect(toBoolean("false")).toBe(true);
    expect(toBoolean([])).toBe(true);
  });

  it("renders values the way format() and join() do", () => {
    expect(toDisplayString(null)).toBe("");
    expect(toDisplayString(true)).toBe("true");
    expect(toDisplayString([1, 2])).toBe("Array");
  });
});

describe("built-in functions", () => {
  it("implements the string and collection helpers", () => {
    expect(value("contains('hello world', 'WORLD')")).toBe(true);
    expect(value("contains(fromJSON('[1,2]'), 2)")).toBe(true);
    expect(value("startsWith('refs/heads/main', 'refs/heads/')")).toBe(true);
    expect(value("endsWith('main.yml', '.YML')")).toBe(true);
    expect(value("join(fromJSON('[\"a\",\"b\"]'), '-')")).toBe("a-b");
    expect(value("fromJSON('{\"n\":1}').n")).toBe(1);
  });

  it("implements format(), including escaped braces", () => {
    expect(value("format('{0}/{1}', 'a', 'b')")).toBe("a/b");
    expect(value("format('{{literal}} {0}', 'x')")).toBe("{literal} x");
  });

  it("assumes a successful run for the status functions", () => {
    expect(value("success()")).toBe(true);
    expect(value("always()")).toBe(true);
    expect(value("failure()")).toBe(false);
    expect(value("cancelled()")).toBe(false);
  });

  it("returns UNKNOWN for things it cannot know", () => {
    expect(value("hashFiles('**/package-lock.json')")).toBe(UNKNOWN);
    expect(value("someFutureFunction('x')")).toBe(UNKNOWN);
    expect(value("fromJSON('not json')")).toBe(UNKNOWN);
  });
});

describe("UNKNOWN propagation", () => {
  it("spreads through operators", () => {
    expect(value("secrets.A == 'x'")).toBe(UNKNOWN);
    expect(value("!secrets.A")).toBe(UNKNOWN);
    expect(value("contains(secrets.A, 'x')")).toBe(UNKNOWN);
  });

  it("stops at a short circuit that is already decided", () => {
    // A known-false left side of && decides the result.
    expect(value("false && secrets.A")).toBe(false);
    expect(value("true || secrets.A")).toBe(true);
    // ...but an undecided left side does not.
    expect(value("secrets.A && true")).toBe(UNKNOWN);
    expect(value("secrets.A || false")).toBe(UNKNOWN);
  });
});

describe("evaluateCondition", () => {
  const check = (condition: string): string => evaluateCondition(condition, CONTEXTS).result;

  it("treats an empty condition as true", () => {
    expect(check("")).toBe("true");
    expect(check("   ")).toBe("true");
  });

  it("evaluates a bare expression, the way `if:` allows", () => {
    expect(check("github.event_name == 'push'")).toBe("true");
    expect(check("github.event_name == 'pull_request'")).toBe("false");
  });

  it("evaluates a wrapped expression", () => {
    expect(check("${{ github.ref == 'refs/heads/main' }}")).toBe("true");
  });

  it("evaluates an interpolated string for truthiness", () => {
    expect(check("prefix-${{ inputs.environment }}")).toBe("true");
    // An interpolation that renders empty is falsy.
    expect(check("${{ vars.missing }}")).toBe("false");
  });

  it("reports unknown when it cannot decide", () => {
    expect(check("needs.build.outputs.ready == 'yes'")).toBe("unknown");
    expect(check("secrets.DEPLOY_KEY != ''")).toBe("unknown");
  });

  it("reports a syntax error as unknown rather than throwing", () => {
    const evaluation = evaluateCondition("github.event_name ==", CONTEXTS);
    expect(evaluation.result).toBe("unknown");
    expect(evaluation.error).toBeTruthy();
  });

  it("handles the real-world conditions workflows actually use", () => {
    expect(check("github.ref == 'refs/heads/main' && github.event_name == 'push'")).toBe("true");
    expect(check("startsWith(github.ref, 'refs/heads/')")).toBe("true");
    expect(check("always()")).toBe("true");
    expect(check("!cancelled()")).toBe("true");
    expect(check("inputs.deploy")).toBe("true");
    expect(check("inputs.count > 5")).toBe("false");
    expect(check("contains(github.event.action, 'open')")).toBe("true");
  });
});
