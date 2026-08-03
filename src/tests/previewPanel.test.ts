/**
 * Covers the VS Code wiring around the controller: panel creation, retargeting on
 * editor changes, live-update debouncing, disposal, source reveal and SVG export.
 * The `vscode` module is faked so this runs as a plain unit test.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => void;
type Disposable = { dispose: () => void };

/** A minimal event emitter matching the shape of a `vscode.Event`. */
function emitter<T>(): { event: (listener: Listener<T>) => Disposable; fire: (value: T) => void } {
  const listeners: Listener<T>[] = [];
  return {
    event: (listener) => {
      listeners.push(listener);
      return {
        dispose: () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        },
      };
    },
    fire: (value) => {
      // Snapshot first: a listener may unsubscribe while the event is dispatching.
      for (const listener of Array.from(listeners)) {
        listener(value);
      }
    },
  };
}

const documentChanged = emitter<{ document: unknown }>();
const documentClosed = emitter<unknown>();
const configChanged = emitter<{ affectsConfiguration: (section: string) => boolean }>();
const activeEditorChanged = emitter<{ document: unknown } | undefined>();

let configValues: Record<string, unknown> = {};
let saveDialogResult: { fsPath: string } | undefined;
let writtenFiles: { path: string; content: string }[] = [];
let executedCommands: { command: string; args: unknown[] }[] = [];
let warnings: string[] = [];
let visibleEditors: FakeEditor[] = [];
let shownDocuments: unknown[] = [];

type FakeEditor = {
  document: { uri: { toString: () => string } };
  selection: unknown;
  revealRange: ReturnType<typeof vi.fn>;
};

type FakePanel = {
  webview: {
    cspSource: string;
    html: string;
    asWebviewUri: (uri: unknown) => { toString: () => string };
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: (listener: Listener<unknown>) => Disposable;
  };
  title: string;
  active: boolean;
  reveal: ReturnType<typeof vi.fn>;
  dispose: () => void;
  onDidDispose: (listener: Listener<void>) => Disposable;
  onDidChangeViewState: (listener: Listener<void>) => Disposable;
  /** Test hooks. */
  send: (message: unknown) => void;
  disposed: boolean;
};

let createdPanels: FakePanel[] = [];

function makePanel(title: string): FakePanel {
  const messages = emitter<unknown>();
  const disposal = emitter<void>();
  const viewState = emitter<void>();
  const panel: FakePanel = {
    webview: {
      cspSource: "vscode-resource://test",
      html: "",
      asWebviewUri: (uri) => ({ toString: () => `webview:${String(uri)}` }),
      postMessage: vi.fn(() => true),
      onDidReceiveMessage: messages.event,
    },
    title,
    active: true,
    reveal: vi.fn(),
    dispose: () => {
      if (!panel.disposed) {
        panel.disposed = true;
        disposal.fire();
      }
    },
    onDidDispose: disposal.event,
    onDidChangeViewState: viewState.event,
    send: messages.fire,
    disposed: false,
  };
  return panel;
}

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/"),
    }),
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  Selection: class {
    constructor(
      public anchor: unknown,
      public active: unknown,
    ) {}
  },
  ViewColumn: { One: 1, Two: 2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  window: {
    createWebviewPanel: (_type: string, title: string) => {
      const panel = makePanel(title);
      createdPanels.push(panel);
      return panel;
    },
    showSaveDialog: async () => saveDialogResult,
    showWarningMessage: (message: string) => {
      warnings.push(message);
      return Promise.resolve();
    },
    showTextDocument: async (document: unknown) => {
      shownDocuments.push(document);
      const editor: FakeEditor = {
        document: document as FakeEditor["document"],
        selection: undefined,
        revealRange: vi.fn(),
      };
      visibleEditors.push(editor);
      return editor;
    },
    get visibleTextEditors() {
      return visibleEditors;
    },
    onDidChangeActiveTextEditor: activeEditorChanged.event,
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => configValues[key] }),
    onDidChangeTextDocument: documentChanged.event,
    onDidCloseTextDocument: documentClosed.event,
    onDidChangeConfiguration: configChanged.event,
    fs: {
      writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
        writtenFiles.push({ path: uri.fsPath, content: Buffer.from(content).toString("utf8") });
      },
    },
  },
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => {
      executedCommands.push({ command, args });
      return Promise.resolve();
    },
  },
}));

const { PreviewManager } = await import("../preview/previewPanel.js");

const FIXTURE = fs.readFileSync(
  path.join(process.cwd(), ".fixtures", "workflows", "fan-out.yml"),
  "utf8",
);
const OTHER = fs.readFileSync(
  path.join(process.cwd(), ".fixtures", "workflows", "simple.yml"),
  "utf8",
);

type FakeDocument = {
  uri: { toString: () => string; fsPath: string; path: string };
  getText: () => string;
  positionAt: (offset: number) => { offset: number };
};

function fakeDocument(
  text = FIXTURE,
  uriPath = "/repo/.github/workflows/fan-out.yml",
): FakeDocument {
  return {
    uri: { toString: () => `file://${uriPath}`, fsPath: uriPath, path: uriPath },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
  };
}

/** The message the panel most recently posted to the webview. */
function lastPosted(panel: FakePanel | undefined): { type: string } | undefined {
  const calls = panel?.webview.postMessage.mock.calls ?? [];
  return calls.at(-1)?.[0] as { type: string } | undefined;
}

let manager: InstanceType<typeof PreviewManager>;

beforeEach(() => {
  vi.useFakeTimers();
  configValues = { updateDelayMs: 100 };
  saveDialogResult = { fsPath: "/tmp/graph.svg" };
  writtenFiles = [];
  executedCommands = [];
  warnings = [];
  visibleEditors = [];
  shownDocuments = [];
  createdPanels = [];
  manager = new PreviewManager({ fsPath: "/ext" } as never);
});

afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

describe("PreviewManager panel lifecycle", () => {
  it("creates a panel, fills in the HTML and renders once", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    expect(createdPanels).toHaveLength(1);
    expect(panel?.webview.html).toContain("vscode-resource://test");
    expect(panel?.webview.html).not.toContain("__CSP_SOURCE__");
    expect(panel?.title).toBe("Graph: fan-out.yml");
    expect(lastPosted(panel)?.type).toBe("graph");
  });

  it("reveals the existing panel instead of opening a second one", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    await manager.show(document as never, 2);
    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0]?.reveal).toHaveBeenCalledWith(2, true);
  });

  it("opens a fresh panel once the old one is disposed", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    createdPanels[0]?.dispose();
    await manager.show(document as never, 2);
    expect(createdPanels).toHaveLength(2);
  });

  it("closes the panel when the previewed document closes", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    documentClosed.fire(document);
    expect(createdPanels[0]?.disposed).toBe(true);
  });

  it("keeps the panel when some other document closes", async () => {
    await manager.show(fakeDocument() as never, 2);
    documentClosed.fire(fakeDocument(OTHER, "/repo/.github/workflows/other.yml"));
    expect(createdPanels[0]?.disposed).toBe(false);
  });

  it("disposes the panel when the manager goes away", async () => {
    await manager.show(fakeDocument() as never, 2);
    manager.dispose();
    expect(createdPanels[0]?.disposed).toBe(true);
  });

  it("tracks focus so the export command knows when it applies", async () => {
    await manager.show(fakeDocument() as never, 2);
    expect(executedCommands).toContainEqual({
      command: "setContext",
      args: ["actionsVisualizer.previewFocused", true],
    });
  });
});

describe("PreviewManager retargeting", () => {
  it("follows the active editor onto another workflow", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();

    const other = fakeDocument(OTHER, "/repo/.github/workflows/simple.yml");
    activeEditorChanged.fire({ document: other });
    await vi.advanceTimersByTimeAsync(0);

    // Still one panel, now pointed at the other file.
    expect(createdPanels).toHaveLength(1);
    expect(panel?.title).toBe("Graph: simple.yml");
    const posted = lastPosted(panel) as { type: string; graph: { header: { fileName: string } } };
    expect(posted.graph.header.fileName).toBe("simple.yml");
  });

  it("ignores an editor that is not a workflow", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();

    activeEditorChanged.fire({
      document: fakeDocument("services:\n  db: {}\n", "/repo/docker-compose.yml"),
    });
    await vi.advanceTimersByTimeAsync(0);

    // The preview keeps showing what it had.
    expect(panel?.title).toBe("Graph: fan-out.yml");
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });

  it("accepts a workflow-shaped draft outside a workflows directory", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    activeEditorChanged.fire({ document: fakeDocument(OTHER, "/tmp/scratch.yml") });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel?.title).toBe("Graph: scratch.yml");
  });

  it("does nothing when the editor change is to the document already shown", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();

    activeEditorChanged.fire({ document });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });

  it("does nothing when no preview is open", async () => {
    activeEditorChanged.fire({ document: fakeDocument() });
    await vi.advanceTimersByTimeAsync(0);
    expect(createdPanels).toHaveLength(0);
  });

  it("survives the active editor closing entirely", async () => {
    await manager.show(fakeDocument() as never, 2);
    // VS Code really does fire `undefined` here, when the last editor closes.
    // eslint-disable-next-line unicorn/no-useless-undefined
    activeEditorChanged.fire(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(createdPanels[0]?.disposed).toBe(false);
  });

  it("retargets through `show` too", async () => {
    await manager.show(fakeDocument() as never, 2);
    await manager.show(fakeDocument(OTHER, "/repo/.github/workflows/simple.yml") as never, 2);
    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0]?.title).toBe("Graph: simple.yml");
  });

  it("routes webview messages to the retargeted document", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];

    const other = fakeDocument(OTHER, "/repo/.github/workflows/simple.yml");
    activeEditorChanged.fire({ document: other });
    await vi.advanceTimersByTimeAsync(0);

    panel?.send({ type: "revealSource", offset: 5 });
    await vi.advanceTimersByTimeAsync(0);
    // The reveal must land in the new document, not the one the panel opened with.
    expect(shownDocuments).toEqual([other]);
  });

  it("drops a pending re-render when it retargets", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    const panel = createdPanels[0];

    documentChanged.fire({ document });
    activeEditorChanged.fire({
      document: fakeDocument(OTHER, "/repo/.github/workflows/simple.yml"),
    });
    await vi.advanceTimersByTimeAsync(0);
    panel?.webview.postMessage.mockClear();

    // The debounce from the old document must not fire against the new one.
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe("PreviewManager live update", () => {
  it("re-renders after the configured debounce", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();

    documentChanged.fire({ document });
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(panel?.webview.postMessage).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of edits into a single render", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();

    documentChanged.fire({ document });
    await vi.advanceTimersByTimeAsync(50);
    documentChanged.fire({ document });
    await vi.advanceTimersByTimeAsync(50);
    documentChanged.fire({ document });
    await vi.advanceTimersByTimeAsync(100);
    expect(panel?.webview.postMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing when live update is off", async () => {
    configValues = { liveUpdate: false };
    const document = fakeDocument();
    await manager.show(document as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();
    documentChanged.fire({ document });
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });

  it("ignores edits to documents the preview is not showing", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();
    documentChanged.fire({ document: fakeDocument(OTHER, "/repo/other.yml") });
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });

  it("re-renders when settings change", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();
    configChanged.fire({ affectsConfiguration: (section) => section === "actions-visualizer" });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel?.webview.postMessage).toHaveBeenCalled();
  });

  it("ignores unrelated settings changes", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();
    configChanged.fire({ affectsConfiguration: () => false });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });

  it("cancels a pending render when the panel is disposed mid-debounce", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    const panel = createdPanels[0];
    panel?.webview.postMessage.mockClear();
    documentChanged.fire({ document });
    panel?.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel?.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe("PreviewManager source reveal", () => {
  it("moves the selection in an already visible editor", async () => {
    const document = fakeDocument();
    const editor: FakeEditor = {
      document: { uri: { toString: () => document.uri.toString() } },
      selection: undefined,
      revealRange: vi.fn(),
    };
    visibleEditors = [editor];
    await manager.show(document as never, 2);
    createdPanels[0]?.send({ type: "revealSource", offset: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(editor.revealRange).toHaveBeenCalled();
    expect(shownDocuments).toEqual([]);
  });

  it("opens the document when it is not visible", async () => {
    const document = fakeDocument();
    await manager.show(document as never, 2);
    createdPanels[0]?.send({ type: "revealSource", offset: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(shownDocuments).toEqual([document]);
  });

  it("clamps an offset beyond the end of the file", async () => {
    const document = fakeDocument();
    const positionAt = vi.spyOn(document, "positionAt");
    await manager.show(document as never, 2);
    createdPanels[0]?.send({ type: "revealSource", offset: 10_000_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(positionAt).toHaveBeenCalledWith(FIXTURE.length);
  });
});

describe("PreviewManager export", () => {
  it("warns when there is nothing to export", async () => {
    await manager.exportActive();
    expect(warnings).toEqual(["Open a workflow graph before exporting it."]);
  });

  it("asks the panel for its SVG and writes it", async () => {
    await manager.show(fakeDocument() as never, 2);
    const panel = createdPanels[0];
    await manager.exportActive();
    expect(panel?.webview.postMessage).toHaveBeenCalledWith({ type: "requestExport" });

    panel?.send({ type: "exportSvg", svg: "<svg>graph</svg>" });
    await vi.advanceTimersByTimeAsync(0);
    expect(writtenFiles).toEqual([{ path: "/tmp/graph.svg", content: "<svg>graph</svg>" }]);
  });

  it("writes nothing when the save dialog is dismissed", async () => {
    saveDialogResult = undefined;
    await manager.show(fakeDocument() as never, 2);
    createdPanels[0]?.send({ type: "exportSvg", svg: "<svg />" });
    await vi.advanceTimersByTimeAsync(0);
    expect(writtenFiles).toEqual([]);
  });

  it("warns again once the panel has been disposed", async () => {
    await manager.show(fakeDocument() as never, 2);
    createdPanels[0]?.dispose();
    await manager.exportActive();
    expect(warnings).toEqual(["Open a workflow graph before exporting it."]);
  });
});
