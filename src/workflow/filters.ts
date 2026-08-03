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

/**
 * Whether an event with these `branches:` / `tags:` filters would fire for a ref.
 *
 * A tag ref is tested against `tags:`, a branch ref against `branches:`. Declaring
 * only `tags:` means branch pushes do not trigger the workflow at all, and vice
 * versa — which is the case the preview used to get wrong.
 */
export function refMatchesFilters(
  ref: string,
  filters: { branches: string[]; tags: string[] },
): RefFilterResult {
  const name = refName(ref);

  if (isTagRef(ref)) {
    if (filters.tags.length === 0) {
      return filters.branches.length === 0
        ? { matches: true }
        : { matches: false, reason: "the event only declares `branches:` filters" };
    }
    return matchesFilter(filters.tags, name)
      ? { matches: true }
      : { matches: false, reason: `\`${name}\` does not match any \`tags:\` filter` };
  }

  if (filters.branches.length === 0) {
    return filters.tags.length === 0
      ? { matches: true }
      : { matches: false, reason: "the event only declares `tags:` filters" };
  }
  return matchesFilter(filters.branches, name)
    ? { matches: true }
    : { matches: false, reason: `\`${name}\` does not match any \`branches:\` filter` };
}
