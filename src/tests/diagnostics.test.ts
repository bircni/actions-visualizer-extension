import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => void;
type Disposable = { dispose: () => void };

/**
 * A faithful `vscode.Event` fake: disposing really does unsubscribe, which is
 * what keeps one test's collector from hearing the next test's events — and
 * incidentally proves the subject cleans up after itself.
 */
function emitter<T>(): {
  event: (listener: Listener<T>) => Disposable;
  fire: (value: T) => void;
  listenerCount: () => number;
} {
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
      for (const listener of Array.from(listeners)) {
        listener(value);
      }
    },
    listenerCount: () => listeners.length,
  };
}

const documentOpened = emitter<unknown>();
const documentChanged = emitter<{ document: unknown }>();
const documentClosed = emitter<unknown>();

type Entry = { uri: unknown; diagnostics: { message: string; severity: number }[] };

let published: Entry[] = [];
let deleted: unknown[] = [];
let openDocuments: unknown[] = [];
let collectionDisposed = false;

vi.mock("vscode", () => ({
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri: unknown, diagnostics: { message: string; severity: number }[]) => {
        published.push({ uri, diagnostics });
      },
      delete: (uri: unknown) => {
        deleted.push(uri);
      },
      dispose: () => {
        collectionDisposed = true;
      },
    }),
  },
  workspace: {
    get textDocuments() {
      return openDocuments;
    },
    onDidOpenTextDocument: documentOpened.event,
    onDidChangeTextDocument: documentChanged.event,
    onDidCloseTextDocument: documentClosed.event,
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  Diagnostic: class {
    public source: string | undefined;
    constructor(
      public range: unknown,
      public message: string,
      public severity: number,
    ) {}
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
}));

const { WorkflowDiagnostics } = await import("../preview/diagnostics.js");

const BROKEN_NEEDS = "on: push\njobs:\n  a:\n    needs: ghost\n";

function fakeDocument(text: string, uriPath = "/repo/.github/workflows/ci.yml") {
  return {
    uri: { fsPath: uriPath, toString: () => `file://${uriPath}` },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
  };
}

beforeEach(() => {
  published = [];
  deleted = [];
  openDocuments = [];
  collectionDisposed = false;
});

describe("WorkflowDiagnostics", () => {
  it("publishes findings for a workflow file", () => {
    const diagnostics = new WorkflowDiagnostics();
    diagnostics.refresh(fakeDocument(BROKEN_NEEDS) as never);

    const entry = published.at(-1);
    expect(entry?.diagnostics).toHaveLength(1);
    expect(entry?.diagnostics[0]?.message).toContain("`ghost`");
    // Errors map to the highest severity so they surface at the top.
    expect(entry?.diagnostics[0]?.severity).toBe(0);
    diagnostics.dispose();
  });

  it("maps each severity to its editor equivalent", () => {
    const diagnostics = new WorkflowDiagnostics();
    diagnostics.refresh(
      fakeDocument(
        [
          "on: push",
          "jobs:",
          "  a:",
          "    needs: ghost",
          "  b:",
          "    if: env.X == '1'",
          "  c:",
          "    outputs:",
          "      v: ${{ steps.x.outputs.v }}",
        ].join("\n"),
      ) as never,
    );
    const severities = published.at(-1)?.diagnostics.map((d) => d.severity) ?? [];
    expect(severities).toContain(0); // error: missing needs
    expect(severities).toContain(1); // warning: unavailable context
    expect(severities).toContain(2); // information: unread outputs
    diagnostics.dispose();
  });

  it("publishes an empty list for a healthy workflow, clearing any stale entry", () => {
    const diagnostics = new WorkflowDiagnostics();
    diagnostics.refresh(fakeDocument("on: push\njobs:\n  a:\n  b:\n    needs: a\n") as never);
    expect(published.at(-1)?.diagnostics).toEqual([]);
    diagnostics.dispose();
  });

  it("ignores a file outside a workflows directory", () => {
    const diagnostics = new WorkflowDiagnostics();
    diagnostics.refresh(fakeDocument(BROKEN_NEEDS, "/repo/scratch.yml") as never);
    expect(published).toEqual([]);
    diagnostics.dispose();
  });

  it("reports nothing for a file that does not parse", () => {
    const diagnostics = new WorkflowDiagnostics();
    diagnostics.refresh(fakeDocument("jobs:\n  a:\n   steps: []\n") as never);
    expect(published.at(-1)?.diagnostics).toEqual([]);
    diagnostics.dispose();
  });

  it("lints the workflows already open when it starts", () => {
    openDocuments = [fakeDocument(BROKEN_NEEDS)];
    const diagnostics = new WorkflowDiagnostics();
    expect(published).toHaveLength(1);
    diagnostics.dispose();
  });

  it("re-lints on open and on edit", () => {
    const diagnostics = new WorkflowDiagnostics();
    const document = fakeDocument(BROKEN_NEEDS);
    documentOpened.fire(document);
    expect(published).toHaveLength(1);
    documentChanged.fire({ document });
    expect(published).toHaveLength(2);
    diagnostics.dispose();
  });

  it("clears a document's diagnostics when it closes", () => {
    const diagnostics = new WorkflowDiagnostics();
    const document = fakeDocument(BROKEN_NEEDS);
    documentClosed.fire(document);
    expect(deleted).toEqual([document.uri]);
    diagnostics.dispose();
  });

  it("clamps a range that runs past the end of the file", () => {
    const diagnostics = new WorkflowDiagnostics();
    const document = fakeDocument(BROKEN_NEEDS);
    const positionAt = vi.spyOn(document, "positionAt");
    diagnostics.refresh(document as never);
    for (const call of positionAt.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(BROKEN_NEEDS.length);
    }
    diagnostics.dispose();
  });

  it("disposes its collection and unsubscribes from every event", () => {
    const diagnostics = new WorkflowDiagnostics();
    expect(documentChanged.listenerCount()).toBe(1);
    diagnostics.dispose();
    expect(collectionDisposed).toBe(true);
    expect(documentOpened.listenerCount()).toBe(0);
    expect(documentChanged.listenerCount()).toBe(0);
    expect(documentClosed.listenerCount()).toBe(0);
  });
});
