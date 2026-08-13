import { beforeEach, describe, expect, it, vi } from "vitest";
import { lintWorkflow } from "../workflow/lint.js";
import { parseWorkflow } from "../workflow/parse.js";

class Kind {
  constructor(public readonly value: string) {}
  public append(part: string): Kind {
    return new Kind(`${this.value}.${part}`);
  }
}

type Replacement = { uri: unknown; range: { start: Position; end: Position }; text: string };
type Position = { offset: number };

vi.mock("vscode", () => ({
  CodeActionKind: {
    QuickFix: new Kind("quickfix"),
    SourceFixAll: new Kind("source.fixAll"),
  },
  CodeAction: class {
    public diagnostics: unknown[] | undefined;
    public edit: unknown;
    public isPreferred: boolean | undefined;
    constructor(
      public title: string,
      public kind: Kind,
    ) {}
  },
  WorkspaceEdit: class {
    public replacements: Replacement[] = [];
    public replace(uri: unknown, range: Replacement["range"], text: string): void {
      this.replacements.push({ uri, range, text });
    }
  },
  Range: class {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  },
}));

const { WorkflowCodeActionsProvider } = await import("../preview/codeActions.js");

function document(text: string, path = "/repo/.github/workflows/ci.yml") {
  return {
    uri: { fsPath: path },
    getText: () => text,
    positionAt: (offset: number): Position => ({ offset }),
    offsetAt: (position: Position): number => position.offset,
  };
}

function diagnostic(text: string, code: string) {
  const finding = lintWorkflow(parseWorkflow(text), { inputs: {} }).find(
    (candidate) => candidate.code === code,
  );
  if (finding?.range == null) {
    throw new Error(`No ranged finding for ${code}`);
  }
  return {
    source: "Actions Visualizer",
    code: finding.code,
    message: finding.message,
    range: { start: { offset: finding.range.start }, end: { offset: finding.range.end } },
  };
}

describe("WorkflowCodeActionsProvider", () => {
  let provider: InstanceType<typeof WorkflowCodeActionsProvider>;

  beforeEach(() => {
    provider = new WorkflowCodeActionsProvider();
  });

  it("offers the matching preferred quick fix and a safe Fix All action", () => {
    const text = "on: push\njobs:\n  a:\n  b:\n    needs: [a, a]\n";
    const actions = provider.provideCodeActions(
      document(text) as never,
      {} as never,
      {
        diagnostics: [diagnostic(text, "duplicate-needs")],
      } as never,
    );
    expect(actions.map((action) => action.title)).toEqual([
      "Remove duplicate dependency 'a'",
      "Fix all safe Actions Visualizer issues",
    ]);
    expect(actions[0]?.isPreferred).toBe(true);
    const quickFixEdit = actions[0]?.edit as { replacements: Replacement[] } | undefined;
    expect(quickFixEdit?.replacements).toHaveLength(2);
  });

  it("keeps a semantic fix non-preferred and out of Fix All", () => {
    const text = "on: push\njobs:\n  a:\n    needs: ghost\n";
    const actions = provider.provideCodeActions(
      document(text) as never,
      {} as never,
      {
        diagnostics: [diagnostic(text, "missing-needs")],
      } as never,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: "Remove undefined dependency 'ghost'",
      isPreferred: false,
    });
  });

  it("ignores diagnostics from other tools and stale diagnostic ranges", () => {
    const text = "on: push\njobs:\n  a:\n    needs: ghost\n";
    const current = diagnostic(text, "missing-needs");
    const actions = provider.provideCodeActions(
      document(text) as never,
      {} as never,
      {
        diagnostics: [
          { ...current, source: "Other" },
          { ...current, range: { start: { offset: 0 }, end: { offset: 1 } } },
        ],
      } as never,
    );
    expect(actions).toEqual([]);
  });

  it("does not act on YAML outside a workflow directory", () => {
    const text = "on: push\njobs:\n  a:\n    needs: ghost\n";
    const actions = provider.provideCodeActions(
      document(text, "/repo/config.yml") as never,
      {} as never,
      { diagnostics: [diagnostic(text, "missing-needs")] } as never,
    );
    expect(actions).toEqual([]);
  });
});
