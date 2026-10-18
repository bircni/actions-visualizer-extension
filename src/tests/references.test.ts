import { describe, expect, it } from "vitest";
import {
  isLocalReference,
  localReferenceCandidates,
  repositoryRoot,
} from "../workflow/references.js";

describe("isLocalReference", () => {
  it("accepts only paths relative to the repository", () => {
    expect(isLocalReference("./.github/workflows/deploy.yml")).toBe(true);
    expect(isLocalReference("./actions/setup")).toBe(true);
    expect(isLocalReference("actions/checkout@v5")).toBe(false);
    expect(isLocalReference("docker://alpine:3")).toBe(false);
    expect(isLocalReference("octo/repo/.github/workflows/x.yml@main")).toBe(false);
  });
});

describe("repositoryRoot", () => {
  it("is the directory holding the workflows folder", () => {
    expect(repositoryRoot("/home/me/repo/.github/workflows/ci.yml")).toBe("/home/me/repo");
    expect(repositoryRoot("/srv/repo/.gitea/workflows/ci.yml")).toBe("/srv/repo");
    expect(repositoryRoot("/c:/work/repo/.github/workflows/ci.yml")).toBe("/c:/work/repo");
  });

  it("handles a repository at the file-system root", () => {
    expect(repositoryRoot("/.github/workflows/ci.yml")).toBe("/");
  });

  it("is unknown for a draft outside a workflows folder", () => {
    expect(repositoryRoot("/tmp/scratch.yml")).toBeUndefined();
    expect(repositoryRoot("/repo/.github/ci.yml")).toBeUndefined();
  });
});

describe("localReferenceCandidates", () => {
  it("names a reusable workflow file directly", () => {
    expect(localReferenceCandidates("/repo", "./.github/workflows/deploy.yml")).toEqual([
      "/repo/.github/workflows/deploy.yml",
    ]);
    expect(localReferenceCandidates("/repo", "./ci/build.YAML")).toEqual(["/repo/ci/build.YAML"]);
  });

  it("looks for an action's metadata file inside its directory", () => {
    expect(localReferenceCandidates("/repo", "./.github/actions/setup")).toEqual([
      "/repo/.github/actions/setup/action.yml",
      "/repo/.github/actions/setup/action.yaml",
    ]);
    expect(localReferenceCandidates("/repo", "./.github/actions/setup/")).toEqual([
      "/repo/.github/actions/setup/action.yml",
      "/repo/.github/actions/setup/action.yaml",
    ]);
  });

  it("refuses anything that is not local or that climbs out of the repository", () => {
    expect(localReferenceCandidates("/repo", "actions/checkout@v5")).toEqual([]);
    expect(localReferenceCandidates("/repo", "./../secrets.yml")).toEqual([]);
    expect(localReferenceCandidates("/repo", "./a/../../etc/passwd")).toEqual([]);
    expect(localReferenceCandidates("/repo", "./")).toEqual([]);
  });
});
