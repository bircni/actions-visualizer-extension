/**
 * Publishes workflow problems to the editor's Problems panel.
 *
 * The preview banner only helps someone who has the graph open; a diagnostic
 * reaches everyone editing the file. This module owns the one place that turns
 * {@link LintFinding}s into `vscode.Diagnostic`s.
 */

import * as vscode from "vscode";
import { isWorkflowFile } from "../workflow/detect.js";
import { lintWorkflow, type LintSeverity } from "../workflow/lint.js";
import { parseWorkflow } from "../workflow/parse.js";
import type { Simulation } from "../workflow/simulate.js";

const SOURCE = "Actions Visualizer";

function severityOf(severity: LintSeverity): vscode.DiagnosticSeverity {
  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }
  return severity === "warning"
    ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
}

/** Keeps the Problems panel in step with the workflow files that are open. */
export class WorkflowDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("actionsVisualizer");
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.refresh(document);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.refresh(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.collection.delete(document.uri);
      }),
    );

    for (const document of vscode.workspace.textDocuments) {
      this.refresh(document);
    }
  }

  /**
   * Re-lints a document.
   *
   * Only files inside a workflows directory are linted. A scratch draft can be
   * previewed, but reporting problems against an arbitrary YAML file the user
   * never called a workflow would be presumptuous.
   */
  public refresh(document: vscode.TextDocument, simulation?: Simulation): void {
    if (!isWorkflowFile(document.uri.fsPath)) {
      return;
    }

    const text = document.getText();
    const findings = lintWorkflow(parseWorkflow(text), simulation ?? { inputs: {} });
    const diagnostics = findings.map((finding) => {
      const start = document.positionAt(Math.min(finding.range?.start ?? 0, text.length));
      const end = document.positionAt(Math.min(finding.range?.end ?? 0, text.length));
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end),
        finding.message,
        severityOf(finding.severity),
      );
      diagnostic.source = SOURCE;
      return diagnostic;
    });

    this.collection.set(document.uri, diagnostics);
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
