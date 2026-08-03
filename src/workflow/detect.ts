/**
 * Detection of workflow files for GitHub Actions (`.github/workflows`) and
 * Gitea Actions (`.gitea/workflows`). Both use the same YAML syntax, so only
 * the containing directory differs.
 */

const WORKFLOW_DIR_PATTERN = /[/\\]\.(?:github|gitea)[/\\]workflows[/\\][^/\\]+$/;
const YAML_EXTENSION_PATTERN = /\.ya?ml$/i;

/** Platform a workflow file belongs to, derived from its path. */
export type WorkflowPlatform = "github" | "gitea";

/**
 * True when the path points at a workflow file inside a `.github` or `.gitea`
 * workflows directory. Accepts both POSIX and Windows separators.
 */
export function isWorkflowFile(fsPath: string): boolean {
  return WORKFLOW_DIR_PATTERN.test(fsPath) && YAML_EXTENSION_PATTERN.test(fsPath);
}

/** Platform for a workflow path, or undefined when the path is not a workflow file. */
export function detectPlatform(fsPath: string): WorkflowPlatform | undefined {
  if (!isWorkflowFile(fsPath)) {
    return undefined;
  }
  return /[/\\]\.gitea[/\\]/.test(fsPath) ? "gitea" : "github";
}

/**
 * True when the document looks like a workflow even outside a workflows directory.
 * Used so the preview still works on a scratch file the user is drafting.
 */
export function looksLikeWorkflow(text: string): boolean {
  return /^on\s*:/m.test(text) && /^jobs\s*:/m.test(text);
}
