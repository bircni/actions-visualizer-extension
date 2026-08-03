/**
 * Webview panel lifecycle for the workflow graph preview.
 *
 * One panel per workflow document, keyed by URI, mirroring how the built-in
 * Markdown preview behaves. All the interesting logic lives in
 * {@link createPreviewController}; this module only wires VS Code APIs into it.
 */

import * as vscode from "vscode";
import { logger } from "../logger.js";
import { getInitialHtml } from "../webview/content.js";
import { readPreviewSettings } from "./previewConfig.js";
import {
  createPreviewController,
  type PreviewController,
  type WebviewHostMessage,
} from "./previewController.js";
import { clearActivePreviewSession, setActivePreviewSession } from "./previewTestBridge.js";

const VIEW_TYPE = "actionsVisualizer.preview";
/** Context key that gates the export command in the command palette. */
const FOCUS_CONTEXT_KEY = "actionsVisualizer.previewFocused";

type PreviewEntry = {
  panel: vscode.WebviewPanel;
  controller: PreviewController;
  document: vscode.TextDocument;
};

/** Writes an SVG to a user-chosen path, returning the path or undefined if cancelled. */
async function promptAndWriteSvg(
  svg: string,
  defaultName: string,
  sourceUri: vscode.Uri,
): Promise<string | undefined> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(sourceUri, "..", defaultName),
    filters: { "SVG image": ["svg"] },
  });
  if (!target) {
    return undefined;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(svg, "utf8"));
  return target.fsPath;
}

/** Moves the cursor in the editor showing `document` to a byte offset. */
async function revealOffset(document: vscode.TextDocument, offset: number): Promise<void> {
  const clamped = Math.min(Math.max(offset, 0), document.getText().length);
  const position = document.positionAt(clamped);
  const range = new vscode.Range(position, position);
  const visible = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === document.uri.toString(),
  );
  const editor =
    visible ??
    (await vscode.window.showTextDocument(document, {
      preserveFocus: false,
      preview: false,
      viewColumn: vscode.ViewColumn.One,
    }));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Owns every open preview panel and keeps them in sync with their documents. */
export class PreviewManager implements vscode.Disposable {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingRenders = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly extensionUri: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.scheduleRender(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.entries.get(document.uri.toString())?.panel.dispose();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("actions-visualizer")) {
          for (const entry of this.entries.values()) {
            void entry.controller.render();
          }
        }
      }),
    );
  }

  /** Opens or focuses the preview for a document. */
  public async show(document: vscode.TextDocument, column: vscode.ViewColumn): Promise<void> {
    const key = document.uri.toString();
    const existing = this.entries.get(key);
    if (existing) {
      existing.panel.reveal(column, true);
      await existing.controller.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Graph: ${document.uri.path.split("/").pop() ?? "workflow"}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
      },
    );

    const codiconsStyleHref = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "codicon.css"))
      .toString();
    panel.webview.html = getInitialHtml(panel.webview.cspSource, { codiconsStyleHref });

    const controller = createPreviewController({
      readText: () => document.getText(),
      readPath: () => document.uri.fsPath,
      readSettings: () => readPreviewSettings(document.uri),
      postMessage: (message) => panel.webview.postMessage(message),
      revealSource: (offset) => revealOffset(document, offset),
      saveSvg: (svg, defaultName) => promptAndWriteSvg(svg, defaultName, document.uri),
      logInfo: (message, data) => {
        logger.info(message, data);
      },
      logError: (message, error) => {
        logger.error(message, error);
      },
    });

    const entry: PreviewEntry = { panel, controller, document };
    this.entries.set(key, entry);
    setActivePreviewSession({ owner: panel, controller });

    const subscriptions: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void controller.handleMessage(message as WebviewHostMessage);
      }),
      panel.onDidChangeViewState(() => {
        void vscode.commands.executeCommand("setContext", FOCUS_CONTEXT_KEY, panel.active);
      }),
    ];

    panel.onDidDispose(() => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      const timer = this.pendingRenders.get(key);
      if (timer) {
        clearTimeout(timer);
        this.pendingRenders.delete(key);
      }
      this.entries.delete(key);
      clearActivePreviewSession(panel);
      void vscode.commands.executeCommand("setContext", FOCUS_CONTEXT_KEY, false);
    });

    void vscode.commands.executeCommand("setContext", FOCUS_CONTEXT_KEY, true);
    logger.info("Opened workflow graph preview", { path: document.uri.fsPath });
    await controller.render();
  }

  /** Asks the focused preview to serialise and save its SVG. */
  public async exportActive(): Promise<void> {
    const entry = [...this.entries.values()].find((candidate) => candidate.panel.active);
    const target = entry ?? [...this.entries.values()][0];
    if (!target) {
      void vscode.window.showWarningMessage("Open a workflow graph before exporting it.");
      return;
    }
    await target.controller.requestExport();
  }

  /** Re-renders after an edit, debounced by the configured delay. */
  private scheduleRender(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const settings = readPreviewSettings(document.uri);
    if (!settings.liveUpdate) {
      return;
    }
    const existing = this.pendingRenders.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pendingRenders.set(
      key,
      setTimeout(() => {
        this.pendingRenders.delete(key);
        void entry.controller.render();
      }, settings.updateDelayMs),
    );
  }

  public dispose(): void {
    for (const timer of this.pendingRenders.values()) {
      clearTimeout(timer);
    }
    this.pendingRenders.clear();
    // Disposing a panel deletes its entry, so snapshot the list before iterating.
    for (const entry of Array.from(this.entries.values())) {
      entry.panel.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
