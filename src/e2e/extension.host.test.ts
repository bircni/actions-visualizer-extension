/**
 * Extension-host smoke tests. These run inside a real VS Code instance and drive
 * the preview through the `__test.*` command bridge, since the webview itself is
 * not reachable from here.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

type PreviewRow = { id: string; jobId: string; title: string; state: string; expanded: boolean };

type PreviewState = {
  graph?: {
    header: { title: string; fileName: string; triggers: { event: string; selected: boolean }[] };
    cards: { id: string; kind: string; rows: PreviewRow[] }[];
    edges: { from: string; to: string; broken: boolean }[];
    warnings: string[];
    error?: string;
    direction: string;
  };
  expanded: string[];
  direction: string;
  simulation: { event?: string; ref?: string; inputs: Record<string, unknown> };
};

/** Every row across every card, which is what most assertions care about. */
function rows(graph: NonNullable<PreviewState["graph"]>): PreviewRow[] {
  return graph.cards.flatMap((card) => card.rows);
}

const FAN_OUT = [
  "name: Fan Out",
  "on:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm run build",
  "  test:",
  "    needs: build",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm test",
  "",
].join("\n");

let tempDir: string;

/** Polls an async producer until it yields a value, or the timeout elapses. */
async function waitFor<T>(
  produce: () => Promise<T | undefined>,
  { timeoutMs = 15_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await produce();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error("timed out waiting for a condition");
}

async function getState(): Promise<PreviewState | undefined> {
  return vscode.commands.executeCommand<PreviewState | undefined>(
    "actionsVisualizer.__test.getState",
  );
}

/** Polls the bridge until a rendered graph is available. */
async function waitForGraph(
  predicate: (state: PreviewState) => boolean = () => true,
): Promise<NonNullable<PreviewState["graph"]>> {
  const state = await waitFor(async () => {
    const current = await getState();
    return current?.graph && predicate(current) ? current : undefined;
  });
  assert.ok(state.graph, "expected a rendered graph");
  return state.graph;
}

async function openWorkflow(name: string, content: string): Promise<vscode.TextDocument> {
  const dir = path.join(tempDir, ".github", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

describe("Actions Visualizer extension host", function () {
  this.timeout(60_000);

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "actions-visualizer-e2e-"));
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("activates and contributes its commands", async () => {
    // Activation is `onLanguage:yaml`, so the commands do not exist until a YAML
    // file has been opened at least once.
    const extension = vscode.extensions.getExtension("bircni.actions-visualizer");
    assert.ok(extension, "the extension under test should be loaded");
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("actionsVisualizer.showPreviewToSide"));
    assert.ok(commands.includes("actionsVisualizer.showPreview"));
    assert.ok(commands.includes("actionsVisualizer.exportSvg"));
  });

  it("renders a graph for a workflow opened to the side", async () => {
    await openWorkflow("fan-out.yml", FAN_OUT);
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");

    const graph = await waitForGraph();
    assert.strictEqual(graph.header.title, "Fan Out");
    assert.strictEqual(graph.header.fileName, "fan-out.yml");
    assert.deepStrictEqual(
      graph.header.triggers.map((trigger) => trigger.event),
      ["push"],
    );
    // `build` and `test` sit at different depths, so they get a card each.
    assert.strictEqual(graph.cards.length, 2);
    assert.deepStrictEqual(
      rows(graph).map((row) => row.jobId),
      ["build", "test"],
    );
    assert.strictEqual(graph.edges.length, 1);
    assert.strictEqual(graph.error, undefined);
  });

  it("re-renders after the workflow is edited", async () => {
    const document = await openWorkflow("edited.yml", FAN_OUT);
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");
    await waitForGraph();

    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      document.positionAt(document.getText().length),
      [
        "  deploy:",
        "    needs: test",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo go",
        "",
      ].join("\n"),
    );
    assert.ok(await vscode.workspace.applyEdit(edit));

    const graph = await waitForGraph(
      (state) => state.graph != null && rows(state.graph).some((row) => row.jobId === "deploy"),
    );
    assert.strictEqual(graph.cards.length, 3);
  });

  it("expands a job through the message bridge", async () => {
    await openWorkflow("expand.yml", FAN_OUT);
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");
    await waitForGraph();

    await vscode.commands.executeCommand("actionsVisualizer.__test.postMessage", {
      type: "toggleExpand",
      nodeId: "row:build",
    });
    const graph = await waitForGraph(
      (state) =>
        state.graph != null &&
        rows(state.graph).find((row) => row.id === "row:build")?.expanded === true,
    );
    assert.ok(rows(graph).find((row) => row.id === "row:build")?.expanded);
  });

  it("flips the layout direction on request", async () => {
    await openWorkflow("direction.yml", FAN_OUT);
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");
    await waitForGraph();

    await vscode.commands.executeCommand("actionsVisualizer.__test.postMessage", {
      type: "setDirection",
      direction: "TB",
    });
    const graph = await waitForGraph((state) => state.graph?.direction === "TB");
    assert.strictEqual(graph.direction, "TB");
  });

  it("surfaces a warning for an unresolved needs reference", async () => {
    await openWorkflow(
      "missing.yml",
      ["on: push", "jobs:", "  deploy:", "    needs: ghost", "    steps: []", ""].join("\n"),
    );
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");

    const graph = await waitForGraph();
    assert.ok(graph.cards.some((card) => card.kind === "missing"));
    assert.ok(graph.edges.some((edge) => edge.broken));
    assert.ok(graph.warnings.some((warning) => warning.includes("ghost")));
  });

  it("reports a parse error instead of an empty panel", async () => {
    await openWorkflow(
      "broken.yml",
      ["name: Broken", "on: push", "jobs:", "  build:", "    runs-on: x", "   steps: []", ""].join(
        "\n",
      ),
    );
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");

    const graph = await waitForGraph((state) => state.graph?.error != null);
    assert.ok(graph.error);
    assert.deepStrictEqual(graph.cards, []);
    // The header survives so the user still knows which file they are looking at.
    assert.strictEqual(graph.header.fileName, "broken.yml");
  });

  it("renders a Gitea workflow the same way", async () => {
    const dir = path.join(tempDir, ".gitea", "workflows");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "gitea.yml");
    fs.writeFileSync(file, FAN_OUT, "utf8");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");

    const graph = await waitForGraph();
    assert.strictEqual(rows(graph).length, 2);
  });

  it("re-evaluates the graph when the simulated event changes", async () => {
    await openWorkflow(
      "conditional.yml",
      [
        "on: [push, pull_request]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo build",
        "  publish:",
        "    needs: build",
        "    if: github.event_name == 'push'",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo publish",
        "",
      ].join("\n"),
    );
    await vscode.commands.executeCommand("actionsVisualizer.showPreviewToSide");

    // The first declared trigger is selected by default, so `publish` runs.
    const onPush = await waitForGraph();
    assert.strictEqual(rows(onPush).find((row) => row.jobId === "publish")?.state, "run");

    await vscode.commands.executeCommand("actionsVisualizer.__test.postMessage", {
      type: "setEvent",
      value: "pull_request",
    });
    const onPr = await waitForGraph(
      (state) =>
        state.graph != null &&
        rows(state.graph).find((row) => row.jobId === "publish")?.state === "skipped",
    );
    // The skipped job stays in place, dimmed, rather than disappearing.
    assert.strictEqual(rows(onPr).length, rows(onPush).length);
    assert.strictEqual(rows(onPr).find((row) => row.jobId === "build")?.state, "run");
  });
});
