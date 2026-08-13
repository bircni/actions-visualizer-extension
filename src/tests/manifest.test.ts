import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

type ExtensionManifest = { activationEvents?: string[] };

describe("extension manifest", () => {
  it("activates for every workflow language supported by diagnostics and code actions", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as ExtensionManifest;
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining(["onLanguage:yaml", "onLanguage:github-actions-workflow"]),
    );
  });
});
