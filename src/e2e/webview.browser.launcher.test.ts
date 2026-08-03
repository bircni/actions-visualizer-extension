import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("workflow graph browser rendering", () => {
  it("renders and pans the graph in a real browser", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js"),
        "test",
        "test/graph.browser.test.js",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }, 120_000);
});
