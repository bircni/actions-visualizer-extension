/**
 * GitHub's filter pattern matching for `branches:`, `tags:` and friends.
 *
 * The syntax is not glob and not regex: `*` stops at `/`, `**` does not, `+` and
 * `?` apply to the preceding character, and a leading `!` negates. Getting this
 * wrong would make the preview claim a workflow runs when it would not, so it is
 * implemented against the documented rules rather than approximated.
 *
 * See https://docs.github.com/actions/reference/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet
 */

/** Translates one filter pattern into an anchored regular expression. */
function patternToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] ?? "";

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**` crosses `/`; `*` does not.
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "\\") {
      // An escaped character is matched literally, including `*` and `?`.
      const escaped = pattern[index + 1];
      if (escaped != null) {
        source += escaped.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "+" || char === "?") {
      // These are quantifiers on whatever precedes them, which the loop has
      // already emitted. A leading one has nothing to quantify, so drop it.
      source += source.length > 0 ? char : "";
      index += 1;
      continue;
    }

    source += char.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }

  return new RegExp(`^${source}$`);
}

/** True when a single pattern matches, ignoring any leading `!`. */
function matchesPattern(pattern: string, value: string): boolean {
  const bare = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return patternToRegExp(bare).test(value);
}

/**
 * Evaluates a list of filter patterns against a value.
 *
 * GitHub's rules: with no patterns at all, everything matches. Otherwise the
 * value must match at least one positive pattern, and must not match any
 * negative one. A list of only negative patterns matches anything not excluded.
 */
export function matchesFilter(patterns: string[], value: string): boolean {
  if (patterns.length === 0) {
    return true;
  }
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns.filter((pattern) => pattern.startsWith("!"));

  if (negative.some((pattern) => matchesPattern(pattern, value))) {
    return false;
  }
  if (positive.length === 0) {
    return true;
  }
  return positive.some((pattern) => matchesPattern(pattern, value));
}

/** The branch or tag name a ref refers to, or the ref itself when it is bare. */
export function refName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}

/** Whether a ref names a tag rather than a branch. */
export function isTagRef(ref: string): boolean {
  return ref.startsWith("refs/tags/");
}

export type RefFilterResult = {
  /** True when the event would fire for this ref. */
  matches: boolean;
  /** Why not, when it would not. */
  reason?: string;
};

/** The ref filters an event declares. The `-ignore` lists default to empty. */
type RefFilters = {
  branches: string[];
  tags: string[];
  branchesIgnore?: string[];
  tagsIgnore?: string[];
};

/**
 * Whether one kind of ref (branch or tag) passes its include and ignore lists.
 * GitHub forbids declaring both for the same event; if a workflow does anyway,
 * both are applied, which is the stricter reading.
 */
function passesKind(
  name: string,
  include: string[],
  ignore: string[],
  kind: "branches" | "tags",
): RefFilterResult {
  if (ignore.some((pattern) => matchesPattern(pattern, name))) {
    return { matches: false, reason: `\`${name}\` matches a \`${kind}-ignore:\` filter` };
  }
  if (include.length > 0 && !matchesFilter(include, name)) {
    return { matches: false, reason: `\`${name}\` does not match any \`${kind}:\` filter` };
  }
  return { matches: true };
}

/**
 * Whether an event with these `branches:` / `tags:` filters would fire for a ref.
 *
 * A tag ref is tested against `tags:` and `tags-ignore:`, a branch ref against
 * `branches:` and `branches-ignore:`. Declaring filters for only one kind means
 * the other kind does not trigger the workflow at all — which is the case the
 * preview used to get wrong.
 */
export function refMatchesFilters(ref: string, filters: RefFilters): RefFilterResult {
  const name = refName(ref);
  const branchesIgnore = filters.branchesIgnore ?? [];
  const tagsIgnore = filters.tagsIgnore ?? [];
  const filtersBranches = filters.branches.length > 0 || branchesIgnore.length > 0;
  const filtersTags = filters.tags.length > 0 || tagsIgnore.length > 0;

  if (isTagRef(ref)) {
    if (!filtersTags) {
      return filtersBranches
        ? { matches: false, reason: "the event only declares branch filters" }
        : { matches: true };
    }
    return passesKind(name, filters.tags, tagsIgnore, "tags");
  }

  if (!filtersBranches) {
    return filtersTags
      ? { matches: false, reason: "the event only declares tag filters" }
      : { matches: true };
  }
  return passesKind(name, filters.branches, branchesIgnore, "branches");
}
