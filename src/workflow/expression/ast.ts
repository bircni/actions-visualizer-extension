/** AST for the GitHub Actions expression language (the contents of `${{ }}`). */

export type BinaryOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

export type ExpressionNode =
  | { kind: "literal"; value: string | number | boolean | null }
  /** A root context such as `github`, `inputs` or `needs`. */
  | { kind: "context"; name: string }
  | { kind: "property"; target: ExpressionNode; name: string }
  | { kind: "index"; target: ExpressionNode; index: ExpressionNode }
  /** The object filter `a.*` / `a[*]`, which collects values across a collection. */
  | { kind: "filter"; target: ExpressionNode }
  | { kind: "call"; name: string; args: ExpressionNode[] }
  | { kind: "unary"; operator: "!"; operand: ExpressionNode }
  | { kind: "binary"; operator: BinaryOperator; left: ExpressionNode; right: ExpressionNode };

/** Thrown for syntax the expression language does not accept. */
export class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
    this.name = "ExpressionSyntaxError";
  }
}
