import * as vscode from "vscode";
import { logger, setOutputChannel } from "./logger.js";
import { WorkflowDiagnostics } from "./preview/diagnostics.js";
import { PreviewManager } from "./preview/previewPanel.js";
import {
  dispatchPreviewTestMessage,
  getPreviewTestState,
  renderPreviewForTest,
} from "./preview/previewTestBridge.js";
import { isWorkflowFile, looksLikeWorkflow } from "./workflow/detect.js";
import type { WebviewHostMessage } from "./preview/previewController.js";

const ENABLE_TEST_COMMANDS_ENV = "ACTIONS_VISUALIZER_ENABLE_TEST_COMMANDS";

function shouldRegisterTestCommands(): boolean {
  return process.env[ENABLE_TEST_COMMANDS_ENV] === "1";
}

/**
 * The document to preview: the active editor when it holds a workflow, otherwise
 * nothing. Files outside a workflows directory are accepted when their content
 * looks like a workflow, so a scratch draft still previews.
 */
function resolveWorkflowDocument(): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (!document) {
    return undefined;
  }
  if (isWorkflowFile(document.uri.fsPath) || looksLikeWorkflow(document.getText())) {
    return document;
  }
  return undefined;
}

async function showPreview(manager: PreviewManager, toSide: boolean): Promise<void> {
  const document = resolveWorkflowDocument();
  if (!document) {
    void vscode.window.showWarningMessage(
      "Open a GitHub or Gitea Actions workflow file to visualize it.",
    );
    return;
  }
  const active = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
  const column = toSide ? active + 1 : active;
  await manager.show(document, column);
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Actions Visualizer");
  context.subscriptions.push(channel);
  setOutputChannel(channel);

  const manager = new PreviewManager(context.extensionUri);
  const diagnostics = new WorkflowDiagnostics();

  context.subscriptions.push(
    manager,
    diagnostics,
    vscode.commands.registerCommand("actionsVisualizer.showPreviewToSide", () =>
      showPreview(manager, true),
    ),
    vscode.commands.registerCommand("actionsVisualizer.showPreview", () =>
      showPreview(manager, false),
    ),
    vscode.commands.registerCommand("actionsVisualizer.exportSvg", () => manager.exportActive()),
  );

  if (shouldRegisterTestCommands()) {
    logger.info("Registering Actions Visualizer test commands");
    context.subscriptions.push(
      vscode.commands.registerCommand("actionsVisualizer.__test.getState", () =>
        getPreviewTestState(),
      ),
      vscode.commands.registerCommand("actionsVisualizer.__test.postMessage", (message: unknown) =>
        dispatchPreviewTestMessage(message as WebviewHostMessage),
      ),
      vscode.commands.registerCommand("actionsVisualizer.__test.render", () =>
        renderPreviewForTest(),
      ),
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate(): void {}
