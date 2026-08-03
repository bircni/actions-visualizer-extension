import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Command = (...args: unknown[]) => unknown;

let registeredCommands: Map<string, Command>;
let warnings: string[];
let outputChannels: string[];
let activeEditor:
  | { document: { uri: { fsPath: string }; getText: () => string }; viewColumn: number }
  | undefined;
const shownPreviews: { path: string; column: number }[] = [];

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
    }),
  },
  ViewColumn: { One: 1 },
  window: {
    createOutputChannel: (name: string) => {
      outputChannels.push(name);
      return { appendLine: () => {}, dispose: () => {} };
    },
    showWarningMessage: (message: string) => {
      warnings.push(message);
      return Promise.resolve();
    },
    get activeTextEditor() {
      return activeEditor;
    },
  },
  commands: {
    registerCommand: (command: string, handler: Command) => {
      registeredCommands.set(command, handler);
      return { dispose: () => {} };
    },
    executeCommand: () => Promise.resolve(),
  },
  workspace: {
    textDocuments: [],
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  languages: {
    createDiagnosticCollection: () => ({
      set: () => {},
      delete: () => {},
      dispose: () => {},
    }),
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  Diagnostic: class {
    public source: string | undefined;
    constructor(
      public range: unknown,
      public message: string,
      public severity: unknown,
    ) {}
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
}));

vi.mock("../preview/previewPanel.js", () => ({
  PreviewManager: class {
    public show(document: { uri: { fsPath: string } }, column: number): Promise<void> {
      shownPreviews.push({ path: document.uri.fsPath, column });
      return Promise.resolve();
    }
    public exportActive(): Promise<void> {
      shownPreviews.push({ path: "export", column: 0 });
      return Promise.resolve();
    }
    public dispose(): void {
      // nothing to clean up in the fake
    }
  },
}));

const { activate, deactivate } = await import("../extension.js");

const WORKFLOW_TEXT = "on: push\njobs:\n  build:\n    steps: []\n";

function context(): { subscriptions: { dispose: () => void }[]; extensionUri: { fsPath: string } } {
  return { subscriptions: [], extensionUri: { fsPath: "/ext" } };
}

function editor(fsPath: string, text = WORKFLOW_TEXT, viewColumn = 1) {
  return { document: { uri: { fsPath }, getText: () => text }, viewColumn };
}

beforeEach(() => {
  registeredCommands = new Map();
  warnings = [];
  outputChannels = [];
  activeEditor = undefined;
  shownPreviews.length = 0;
  delete process.env["ACTIONS_VISUALIZER_ENABLE_TEST_COMMANDS"];
});

afterEach(() => {
  delete process.env["ACTIONS_VISUALIZER_ENABLE_TEST_COMMANDS"];
});

describe("activate", () => {
  it("creates the output channel and registers the public commands", () => {
    const ctx = context();
    activate(ctx as never);
    expect(outputChannels).toEqual(["Actions Visualizer"]);
    expect([...registeredCommands.keys()]).toEqual([
      "actionsVisualizer.showPreviewToSide",
      "actionsVisualizer.showPreview",
      "actionsVisualizer.exportSvg",
    ]);
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it("registers test commands only when the environment asks for them", () => {
    process.env["ACTIONS_VISUALIZER_ENABLE_TEST_COMMANDS"] = "1";
    activate(context() as never);
    expect([...registeredCommands.keys()]).toContain("actionsVisualizer.__test.getState");
    expect([...registeredCommands.keys()]).toContain("actionsVisualizer.__test.postMessage");
    expect([...registeredCommands.keys()]).toContain("actionsVisualizer.__test.render");
  });

  it("has a deactivate hook that does nothing", () => {
    expect(() => {
      deactivate();
    }).not.toThrow();
  });
});

describe("preview commands", () => {
  it("opens the preview beside the editor", async () => {
    activate(context() as never);
    activeEditor = editor("/repo/.github/workflows/ci.yml");
    await registeredCommands.get("actionsVisualizer.showPreviewToSide")?.();
    expect(shownPreviews).toEqual([{ path: "/repo/.github/workflows/ci.yml", column: 2 }]);
  });

  it("opens the preview in the same column", async () => {
    activate(context() as never);
    activeEditor = editor("/repo/.gitea/workflows/ci.yml");
    await registeredCommands.get("actionsVisualizer.showPreview")?.();
    expect(shownPreviews).toEqual([{ path: "/repo/.gitea/workflows/ci.yml", column: 1 }]);
  });

  it("accepts a draft outside a workflows directory when it looks like a workflow", async () => {
    activate(context() as never);
    activeEditor = editor("/tmp/scratch.yml");
    await registeredCommands.get("actionsVisualizer.showPreview")?.();
    expect(shownPreviews).toHaveLength(1);
  });

  it("warns instead of opening for unrelated files", async () => {
    activate(context() as never);
    activeEditor = editor("/repo/docker-compose.yml", "services:\n  db: {}\n");
    await registeredCommands.get("actionsVisualizer.showPreview")?.();
    expect(shownPreviews).toEqual([]);
    expect(warnings).toEqual(["Open a GitHub or Gitea Actions workflow file to visualize it."]);
  });

  it("warns when no editor is open at all", async () => {
    activate(context() as never);
    await registeredCommands.get("actionsVisualizer.showPreview")?.();
    expect(warnings).toHaveLength(1);
  });

  it("delegates the export command to the manager", async () => {
    activate(context() as never);
    await registeredCommands.get("actionsVisualizer.exportSvg")?.();
    expect(shownPreviews).toEqual([{ path: "export", column: 0 }]);
  });
});
