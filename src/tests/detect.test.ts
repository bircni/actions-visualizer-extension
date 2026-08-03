import { describe, expect, it } from "vitest";
import { detectPlatform, isWorkflowFile, looksLikeWorkflow } from "../workflow/detect.js";

describe("isWorkflowFile", () => {
  it("accepts GitHub and Gitea workflow paths with either YAML extension", () => {
    expect(isWorkflowFile("/repo/.github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowFile("/repo/.github/workflows/ci.yaml")).toBe(true);
    expect(isWorkflowFile("/repo/.gitea/workflows/release.yml")).toBe(true);
  });

  it("accepts Windows separators", () => {
    expect(isWorkflowFile("C:\\repo\\.github\\workflows\\ci.yml")).toBe(true);
    expect(isWorkflowFile("C:\\repo\\.gitea\\workflows\\ci.yaml")).toBe(true);
  });

  it("rejects other YAML files", () => {
    expect(isWorkflowFile("/repo/.github/dependabot.yml")).toBe(false);
    expect(isWorkflowFile("/repo/docker-compose.yml")).toBe(false);
    expect(isWorkflowFile("/repo/.github/workflows/README.md")).toBe(false);
    // Action metadata lives beside workflows but is not one.
    expect(isWorkflowFile("/repo/.github/workflows/nested/dir/ci.yml")).toBe(false);
  });
});

describe("detectPlatform", () => {
  it("distinguishes GitHub from Gitea by directory", () => {
    expect(detectPlatform("/repo/.github/workflows/ci.yml")).toBe("github");
    expect(detectPlatform("/repo/.gitea/workflows/ci.yml")).toBe("gitea");
  });

  it("returns undefined for non-workflow paths", () => {
    expect(detectPlatform("/repo/package.json")).toBeUndefined();
  });
});

describe("looksLikeWorkflow", () => {
  it("recognises a draft outside a workflows directory", () => {
    expect(looksLikeWorkflow("on: push\njobs:\n  build:\n    runs-on: x\n")).toBe(true);
  });

  it("rejects unrelated YAML", () => {
    expect(looksLikeWorkflow("services:\n  db:\n    image: postgres\n")).toBe(false);
    // `jobs:` alone is not enough.
    expect(looksLikeWorkflow("jobs:\n  build: {}\n")).toBe(false);
  });
});
