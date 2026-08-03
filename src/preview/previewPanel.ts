/**
 * Webview panel lifecycle for the workflow graph preview.
 *
 * There is a single preview panel that follows the active editor, mirroring how
 * the built-in Markdown preview behaves: switching to another workflow file
 * retargets the panel rather than opening a second one. Switching to a file that
 * is not a workflow leaves the preview showing what it already had.
 *
 * All the interesting logic lives in {@link createPreviewController}; this module
 * only wires VS Code APIs into it.
 */

import * as vscode from "vscode";
import { logger } from "../logger.js";
import { getInitialHtml } from "../webview/content.js";
import { isWorkflowFile, looksLikeWorkflow } from "../workflow/detect.js";
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

/** True when the preview should be willing to render this document. */
function isPreviewable(document: vscode.TextDocument): boolean {
  return isWorkflowFile(document.uri.fsPath) || looksLikeWorkflow(document.getText());
}

/** Owns the preview panel and keeps it pointed at the right document. */
export class PreviewManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private controller: PreviewController | undefined;
  private document: vscode.TextDocument | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly panelSubscriptions: vscode.Disposable[] = [];
  private pendingRender: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.scheduleRender(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.isCurrent(document)) {
          this.panel?.dispose();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("actions-visualizer")) {
          void this.controller?.render();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Follow the editor, but only onto another workflow: switching to an
        // unrelated file should leave the preview showing what it had.
        if (editor && this.panel && isPreviewable(editor.document)) {
          void this.retarget(editor.document);
        }
      }),
    );
  }

  private isCurrent(document: vscode.TextDocument): boolean {
    return this.document?.uri.toString() === document.uri.toString();
  }

  private static titleFor(document: vscode.TextDocument): string {
    return `Graph: ${document.uri.path.split("/").pop() ?? "workflow"}`;
  }

  /** Opens the preview, or points the existing one at this document. */
  public async show(document: vscode.TextDocument, column: vscode.ViewColumn): Promise<void> {
    if (this.panel) {
      await this.retarget(document);
      this.panel.reveal(column, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PreviewManager.titleFor(document),
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
      },
    );
    this.panel = panel;
    this.document = document;

    const codiconsStyleHref = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "codicon.css"))
      .toString();
    panel.webview.html = getInitialHtml(panel.webview.cspSource, { codiconsStyleHref });

    this.panelSubscriptions.push(
      // Routed through `this.controller` rather than a captured one, so messages
      // always reach the controller for whatever document is current now.
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.controller?.handleMessage(message as WebviewHostMessage);
      }),
      panel.onDidChangeViewState(() => {
        void vscode.commands.executeCommand("setContext", FOCUS_CONTEXT_KEY, panel.active);
      }),
    );

    panel.onDidDispose(() => {
      this.clearPendingRender();
      for (const subscription of this.panelSubscriptions) {
        subscription.dispose();
      }
      this.panelSubscriptions.length = 0;
      this.panel = undefined;
      this.controller = undefined;
      this.document = undefined;
      clearActivePreviewSession(panel);
      void vscode.commands.executeCommand("setContext", FOCUS_CONTEXT_KEY, false);
    });

    void vscode.commands.executeCommand("setContext", FOCUS_CONTEXT_KEY, true);
    this.bindController(document);
    logger.info("Opened workflow graph preview", { path: document.uri.fsPath });
    await this.controller?.render();
  }

  /**
   * Points the open panel at a different document.
   *
   * The controller is rebuilt rather than reused: expansion and simulation state
   * belong to the workflow being shown, and carrying a previous file's selected
   * event over to a new one would be wrong.
   */
  private async retarget(document: vscode.TextDocument): Promise<void> {
    const panel = this.panel;
    if (!panel || this.isCurrent(document)) {
      return;
    }
    this.clearPendingRender();
    this.document = document;
    panel.title = PreviewManager.titleFor(document);
    this.bindController(document);
    logger.info("Retargeted workflow graph preview", { path: document.uri.fsPath });
    await this.controller?.render();
  }

  /** Builds a controller bound to `document` and registers it for the test bridge. */
  private bindController(document: vscode.TextDocument): void {
    const panel = this.panel;
    if (!panel) {
      return;
    }
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
    this.controller = controller;
    setActivePreviewSession({ owner: panel, controller });
  }

  /** Asks the preview to serialise and save its SVG. */
  public async exportActive(): Promise<void> {
    if (!this.controller) {
      void vscode.window.showWarningMessage("Open a workflow graph before exporting it.");
      return;
    }
    await this.controller.requestExport();
  }

  /** Re-renders after an edit, debounced by the configured delay. */
  private scheduleRender(document: vscode.TextDocument): void {
    if (!this.isCurrent(document) || !this.controller) {
      return;
    }
    const settings = readPreviewSettings(document.uri);
    if (!settings.liveUpdate) {
      return;
    }
    this.clearPendingRender();
    this.pendingRender = setTimeout(() => {
      this.pendingRender = undefined;
      void this.controller?.render();
    }, settings.updateDelayMs);
  }

  private clearPendingRender(): void {
    if (this.pendingRender) {
      clearTimeout(this.pendingRender);
      this.pendingRender = undefined;
    }
  }

  public dispose(): void {
    this.clearPendingRender();
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
