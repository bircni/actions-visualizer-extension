import { describe, expect, it } from "vitest";
import { isTagRef, matchesFilter, refMatchesFilters, refName } from "../workflow/filters.js";

describe("matchesFilter", () => {
  it("matches everything when there are no patterns", () => {
    expect(matchesFilter([], "anything")).toBe(true);
  });

  it("matches a literal pattern exactly", () => {
    expect(matchesFilter(["main"], "main")).toBe(true);
    expect(matchesFilter(["main"], "mainline")).toBe(false);
    expect(matchesFilter(["main"], "feature/main")).toBe(false);
  });

  // The examples in GitHub's filter pattern cheat sheet.
  it("stops `*` at a slash", () => {
    expect(matchesFilter(["feature/*"], "feature/my-branch")).toBe(true);
    expect(matchesFilter(["feature/*"], "feature/your-branch")).toBe(true);
    expect(matchesFilter(["feature/*"], "feature/nested/branch")).toBe(false);
  });

  it("lets `**` cross slashes", () => {
    expect(matchesFilter(["feature/**"], "feature/beta-a/my-branch")).toBe(true);
    expect(matchesFilter(["feature/**"], "feature/beta-a/my/branch")).toBe(true);
    expect(matchesFilter(["**"], "all/the/branches")).toBe(true);
  });

  it("applies `+` and `?` to the preceding character", () => {
    expect(matchesFilter(["v1.*"], "v1.9")).toBe(true);
    expect(matchesFilter(["v1.**"], "v1.9.2")).toBe(true);
    expect(matchesFilter(["mona/octocat*"], "mona/octocat")).toBe(true);
    expect(matchesFilter(["mona/octocat*"], "mona/octocats")).toBe(true);
    // `?` makes the preceding character optional.
    expect(matchesFilter(["releases?"], "release")).toBe(true);
    expect(matchesFilter(["releases?"], "releases")).toBe(true);
    // `+` requires one or more of it.
    expect(matchesFilter(["releases+"], "release")).toBe(false);
    expect(matchesFilter(["releases+"], "releasess")).toBe(true);
  });

  it("matches any of several patterns", () => {
    expect(matchesFilter(["main", "dev"], "dev")).toBe(true);
    expect(matchesFilter(["main", "dev"], "other")).toBe(false);
  });

  it("excludes anything a negated pattern matches", () => {
    expect(matchesFilter(["**", "!releases/**-alpha"], "releases/1")).toBe(true);
    expect(matchesFilter(["**", "!releases/**-alpha"], "releases/1-alpha")).toBe(false);
  });

  it("treats an all-negative list as an exclusion list", () => {
    expect(matchesFilter(["!main"], "dev")).toBe(true);
    expect(matchesFilter(["!main"], "main")).toBe(false);
  });

  it("treats an escaped wildcard as a literal", () => {
    expect(matchesFilter(["v1\\.*"], "v1.2")).toBe(true);
    expect(matchesFilter(["v1\\.*"], "v1x2")).toBe(false);
  });

  it("does not let a pattern be read as a regular expression", () => {
    // A dot is literal, not "any character".
    expect(matchesFilter(["v1.0"], "v1x0")).toBe(false);
    expect(matchesFilter(["a(b)c"], "a(b)c")).toBe(true);
  });
});

describe("refName and isTagRef", () => {
  it("strips the ref prefix", () => {
    expect(refName("refs/heads/main")).toBe("main");
    expect(refName("refs/tags/v1.0.0")).toBe("v1.0.0");
    expect(refName("refs/heads/feature/x")).toBe("feature/x");
    expect(refName("main")).toBe("main");
  });

  it("recognises a tag ref", () => {
    expect(isTagRef("refs/tags/v1")).toBe(true);
    expect(isTagRef("refs/heads/main")).toBe(false);
  });
});

describe("refMatchesFilters", () => {
  it("fires for any ref when the event declares no filters", () => {
    expect(refMatchesFilters("refs/heads/anything", { branches: [], tags: [] })).toEqual({
      matches: true,
    });
  });

  it("tests a branch ref against `branches:`", () => {
    const filters = { branches: ["main", "release/*"], tags: [] };
    expect(refMatchesFilters("refs/heads/main", filters).matches).toBe(true);
    expect(refMatchesFilters("refs/heads/release/1", filters).matches).toBe(true);
    const rejected = refMatchesFilters("refs/heads/topic", filters);
    expect(rejected.matches).toBe(false);
    expect(rejected.reason).toContain("`branches:`");
  });

  it("tests a tag ref against `tags:`", () => {
    const filters = { branches: [], tags: ["v*"] };
    expect(refMatchesFilters("refs/tags/v1.0", filters).matches).toBe(true);
    expect(refMatchesFilters("refs/tags/nightly", filters).matches).toBe(false);
  });

  it("does not fire for a branch when only tags are declared", () => {
    const result = refMatchesFilters("refs/heads/main", { branches: [], tags: ["v*"] });
    expect(result.matches).toBe(false);
    expect(result.reason).toContain("only declares `tags:`");
  });

  it("does not fire for a tag when only branches are declared", () => {
    const result = refMatchesFilters("refs/tags/v1", { branches: ["main"], tags: [] });
    expect(result.matches).toBe(false);
    expect(result.reason).toContain("only declares `branches:`");
  });

  it("matches a branch against branch filters even when tag filters exist too", () => {
    const filters = { branches: ["main"], tags: ["v*"] };
    expect(refMatchesFilters("refs/heads/main", filters).matches).toBe(true);
    expect(refMatchesFilters("refs/tags/v1", filters).matches).toBe(true);
    expect(refMatchesFilters("refs/heads/other", filters).matches).toBe(false);
  });
});
