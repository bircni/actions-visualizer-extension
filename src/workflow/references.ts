/**
 * Resolves the local references a workflow can make — `uses: ./…` to a reusable
 * workflow or to an action in the same repository — to the files they name.
 *
 * Pure, and in URI-path form (always `/`-separated), so it works the same for a
 * local folder, a remote workspace and Windows. The caller checks which of the
 * candidates exists.
 */

import { posix } from "node:path";

/** True for `./…`, the only form GitHub resolves against the repository itself. */
export function isLocalReference(reference: string): boolean {
  return reference.startsWith("./");
}

/**
 * The repository root a workflow lives in: the directory holding its `.github`
 * or `.gitea` folder, which is what GitHub resolves `./` against. Undefined for
 * a draft outside a workflows directory.
 */
export function repositoryRoot(workflowPath: string): string | undefined {
  const match = /^(.*?)\/\.(?:github|gitea)\/workflows\//.exec(workflowPath);
  if (match == null) {
    return undefined;
  }
  return match[1] === "" ? "/" : match[1];
}

/**
 * Files a local `uses:` may point at, most likely first. A path ending in
 * `.yml` or `.yaml` is a reusable workflow; anything else is an action
 * directory, whose metadata is `action.yml` or `action.yaml`.
 *
 * Empty when the reference is not local or would climb out of the repository.
 */
export function localReferenceCandidates(root: string, reference: string): string[] {
  if (!isLocalReference(reference)) {
    return [];
  }
  const target = posix.resolve(root, reference);
  const relative = posix.relative(root, target);
  if (relative === "" || relative.startsWith("..") || posix.isAbsolute(relative)) {
    return [];
  }
  if (/\.ya?ml$/i.test(target)) {
    return [target];
  }
  return [posix.join(target, "action.yml"), posix.join(target, "action.yaml")];
}
