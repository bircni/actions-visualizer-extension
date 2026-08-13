/** VS Code adapter for the pure workflow quick-fix builder. */

import * as vscode from "vscode";
import { fixAllSafe, fixesForFinding, type WorkflowTextEdit } from "../workflow/fixes.js";
import { isWorkflowFile } from "../workflow/detect.js";
import { lintWorkflow, type LintFinding } from "../workflow/lint.js";
import { parseWorkflow } from "../workflow/parse.js";

const SOURCE = "Actions Visualizer";
const FIX_ALL_KIND = vscode.CodeActionKind.SourceFixAll.append("actionsVisualizer");

function diagnosticCode(diagnostic: vscode.Diagnostic): string | undefined {
  if (typeof diagnostic.code === "string") {
    return diagnostic.code;
  }
  if (diagnostic.code != null && typeof diagnostic.code === "object") {
    return String(diagnostic.code.value);
  }
  return diagnostic.code == null ? undefined : String(diagnostic.code);
}

function editFor(
  document: vscode.TextDocument,
  edits: readonly WorkflowTextEdit[],
): vscode.WorkspaceEdit {
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of edits) {
    workspaceEdit.replace(
      document.uri,
      new vscode.Range(document.positionAt(edit.range.start), document.positionAt(edit.range.end)),
      edit.replacement,
    );
  }
  return workspaceEdit;
}

function matchingFinding(
  document: vscode.TextDocument,
  findings: readonly LintFinding[],
  diagnostic: vscode.Diagnostic,
): LintFinding | undefined {
  const code = diagnosticCode(diagnostic);
  const start = document.offsetAt(diagnostic.range.start);
  const end = document.offsetAt(diagnostic.range.end);
  return findings.find(
    (finding) =>
      finding.code === code &&
      finding.message === diagnostic.message &&
      finding.range?.start === start &&
      finding.range.end === end,
  );
}

export class WorkflowCodeActionsProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, FIX_ALL_KIND],
  };

  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!isWorkflowFile(document.uri.fsPath)) {
      return [];
    }

    const text = document.getText();
    const model = parseWorkflow(text);
    const findings = lintWorkflow(model, { inputs: {} });
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SOURCE) {
        continue;
      }
      const finding = matchingFinding(document, findings, diagnostic);
      if (finding == null) {
        continue;
      }
      for (const fix of fixesForFinding(text, model, finding)) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = fix.preferred;
        action.edit = editFor(document, fix.edits);
        actions.push(action);
      }
    }

    const allEdits = fixAllSafe(text, model, findings);
    if (allEdits.length > 0) {
      const action = new vscode.CodeAction("Fix all safe Actions Visualizer issues", FIX_ALL_KIND);
      action.edit = editFor(document, allEdits);
      actions.push(action);
    }
    return actions;
  }
}
