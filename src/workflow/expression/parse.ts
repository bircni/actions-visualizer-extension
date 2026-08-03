/**
 * Lexer and Pratt parser for the GitHub Actions expression language.
 *
 * The language has no arithmetic: its operators are `!`, the comparisons, `&&`,
 * `||`, grouping, property access, index access and the `*` object filter. That
 * makes `-` unambiguously part of a numeric literal.
 *
 * See https://docs.github.com/actions/learn-github-actions/expressions.
 */

import { ExpressionSyntaxError, type BinaryOperator, type ExpressionNode } from "./ast.js";

type TokenType = "number" | "string" | "identifier" | "operator" | "punctuation" | "end";

type Token = {
  type: TokenType;
  /** Raw text for identifiers/operators/punctuation; parsed value for literals. */
  text: string;
  value?: string | number;
  position: number;
};

const TWO_CHAR_OPERATORS = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const ONE_CHAR_OPERATORS = new Set(["!", "<", ">"]);
const PUNCTUATION = new Set(["(", ")", "[", "]", ".", ",", "*"]);

const IDENTIFIER_START = /[A-Za-z_]/;
// GitHub allows dashes inside a dereferenced property name, e.g. `inputs.dry-run`.
const IDENTIFIER_PART = /[A-Za-z0-9_-]/;

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "'") {
      const start = index;
      index += 1;
      let text = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'") {
          // A doubled quote is an escaped quote, not the end of the string.
          if (source[index + 1] === "'") {
            text += "'";
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        text += source[index];
        index += 1;
      }
      if (!closed) {
        throw new ExpressionSyntaxError("Unterminated string literal", start);
      }
      tokens.push({ type: "string", text, value: text, position: start });
      continue;
    }

    if (isDigit(char) || (char === "-" && isDigit(source[index + 1] ?? ""))) {
      const start = index;
      if (char === "-") {
        index += 1;
      }
      if (source[index] === "0" && (source[index + 1] === "x" || source[index + 1] === "X")) {
        index += 2;
        while (index < source.length && /[0-9a-fA-F]/.test(source[index] ?? "")) {
          index += 1;
        }
      } else {
        while (index < source.length && isDigit(source[index] ?? "")) {
          index += 1;
        }
        if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
          index += 1;
          while (index < source.length && isDigit(source[index] ?? "")) {
            index += 1;
          }
        }
        if (source[index] === "e" || source[index] === "E") {
          const save = index;
          index += 1;
          if (source[index] === "+" || source[index] === "-") {
            index += 1;
          }
          if (isDigit(source[index] ?? "")) {
            while (index < source.length && isDigit(source[index] ?? "")) {
              index += 1;
            }
          } else {
            index = save;
          }
        }
      }
      const text = source.slice(start, index);
      tokens.push({ type: "number", text, value: Number(text), position: start });
      continue;
    }

    if (IDENTIFIER_START.test(char)) {
      const start = index;
      while (index < source.length && IDENTIFIER_PART.test(source[index] ?? "")) {
        index += 1;
      }
      tokens.push({ type: "identifier", text: source.slice(start, index), position: start });
      continue;
    }

    const twoChar = source.slice(index, index + 2);
    if (TWO_CHAR_OPERATORS.has(twoChar)) {
      tokens.push({ type: "operator", text: twoChar, position: index });
      index += 2;
      continue;
    }
    if (ONE_CHAR_OPERATORS.has(char)) {
      tokens.push({ type: "operator", text: char, position: index });
      index += 1;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      tokens.push({ type: "punctuation", text: char, position: index });
      index += 1;
      continue;
    }

    throw new ExpressionSyntaxError(`Unexpected character \`${char}\``, index);
  }

  tokens.push({ type: "end", text: "", position: source.length });
  return tokens;
}

/** Binding powers; higher binds tighter. */
const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
};
const UNARY_PRECEDENCE = 5;

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { type: "end", text: "", position: 0 };
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private expect(type: TokenType, text: string): Token {
    const token = this.peek();
    if (token.type !== type || token.text !== text) {
      throw new ExpressionSyntaxError(
        `Expected \`${text}\` but found \`${token.text || "end of expression"}\``,
        token.position,
      );
    }
    return this.next();
  }

  public parseExpression(minimumPrecedence = 0): ExpressionNode {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();
      if (token.type !== "operator") {
        break;
      }
      const precedence = BINARY_PRECEDENCE[token.text];
      if (precedence == null || precedence < minimumPrecedence) {
        break;
      }
      this.next();
      // All binary operators are left-associative.
      const right = this.parseExpression(precedence + 1);
      left = { kind: "binary", operator: token.text as BinaryOperator, left, right };
    }

    return left;
  }

  private parseUnary(): ExpressionNode {
    const token = this.peek();
    if (token.type === "operator" && token.text === "!") {
      this.next();
      return { kind: "unary", operator: "!", operand: this.parseExpression(UNARY_PRECEDENCE) };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(target: ExpressionNode): ExpressionNode {
    let node = target;
    for (;;) {
      const token = this.peek();
      if (token.type === "punctuation" && token.text === ".") {
        this.next();
        const property = this.next();
        if (property.type === "punctuation" && property.text === "*") {
          node = { kind: "filter", target: node };
          continue;
        }
        if (property.type !== "identifier") {
          throw new ExpressionSyntaxError("Expected a property name after `.`", property.position);
        }
        node = { kind: "property", target: node, name: property.text };
        continue;
      }
      if (token.type === "punctuation" && token.text === "[") {
        this.next();
        if (this.peek().type === "punctuation" && this.peek().text === "*") {
          this.next();
          this.expect("punctuation", "]");
          node = { kind: "filter", target: node };
          continue;
        }
        const index = this.parseExpression();
        this.expect("punctuation", "]");
        node = { kind: "index", target: node, index };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): ExpressionNode {
    const token = this.next();

    if (token.type === "number") {
      return { kind: "literal", value: typeof token.value === "number" ? token.value : Number.NaN };
    }
    if (token.type === "string") {
      return { kind: "literal", value: String(token.value ?? "") };
    }
    if (token.type === "punctuation" && token.text === "(") {
      const inner = this.parseExpression();
      this.expect("punctuation", ")");
      return inner;
    }
    if (token.type === "identifier") {
      const lowered = token.text.toLowerCase();
      if (lowered === "true") {
        return { kind: "literal", value: true };
      }
      if (lowered === "false") {
        return { kind: "literal", value: false };
      }
      if (lowered === "null") {
        return { kind: "literal", value: null };
      }
      if (this.peek().type === "punctuation" && this.peek().text === "(") {
        this.next();
        const args: ExpressionNode[] = [];
        if (!(this.peek().type === "punctuation" && this.peek().text === ")")) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.peek().type === "punctuation" && this.peek().text === ",") {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect("punctuation", ")");
        return { kind: "call", name: lowered, args };
      }
      return { kind: "context", name: token.text };
    }

    throw new ExpressionSyntaxError(
      `Unexpected \`${token.text || "end of expression"}\``,
      token.position,
    );
  }

  public atEnd(): boolean {
    return this.peek().type === "end";
  }

  public position(): number {
    return this.peek().position;
  }
}

/** Parses a bare expression (the inside of `${{ }}`). Throws on invalid syntax. */
export function parseExpression(source: string): ExpressionNode {
  const parser = new Parser(tokenize(source));
  const node = parser.parseExpression();
  if (!parser.atEnd()) {
    throw new ExpressionSyntaxError("Unexpected trailing input", parser.position());
  }
  return node;
}

/** One piece of an interpolated string such as `refs/heads/${{ inputs.branch }}`. */
export type TemplatePart =
  | { kind: "text"; text: string }
  | { kind: "expression"; node: ExpressionNode };

/**
 * Splits a value into literal text and `${{ }}` expressions.
 *
 * Returns undefined when the value contains no `${{`, which lets callers treat a
 * bare `if:` as a single expression the way GitHub does.
 */
export function parseTemplate(source: string): TemplatePart[] | undefined {
  if (!source.includes("${{")) {
    return undefined;
  }
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("${{", index);
    if (start === -1) {
      parts.push({ kind: "text", text: source.slice(index) });
      break;
    }
    if (start > index) {
      parts.push({ kind: "text", text: source.slice(index, start) });
    }
    const end = source.indexOf("}}", start + 3);
    if (end === -1) {
      throw new ExpressionSyntaxError("Unterminated `${{`", start);
    }
    parts.push({ kind: "expression", node: parseExpression(source.slice(start + 3, end)) });
    index = end + 2;
  }
  return parts;
}
