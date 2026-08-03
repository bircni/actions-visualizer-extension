import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { getInitialHtml } from "../webview/content.js";

const CSP_SOURCE = "vscode-resource://example";
const CODICONS = "vscode-resource://example/codicon.css";

function html(): string {
  return getInitialHtml(CSP_SOURCE, { codiconsStyleHref: CODICONS });
}

describe("getInitialHtml", () => {
  it("substitutes every placeholder", () => {
    const output = html();
    expect(output).not.toContain("__CSP_SOURCE__");
    expect(output).not.toContain("__CODICONS_STYLE__");
    expect(output).toContain(`href="${CODICONS}"`);
  });

  it("locks the page down with a content security policy", () => {
    const output = html();
    expect(output).toContain("default-src 'none'");
    expect(output).toContain(`script-src 'unsafe-inline' ${CSP_SOURCE}`);
    expect(output).toContain(`font-src ${CSP_SOURCE}`);
  });

  it("tolerates a missing codicon href", () => {
    expect(getInitialHtml(CSP_SOURCE)).toContain('href=""');
  });

  it("inserts replacements verbatim rather than as substitution patterns", () => {
    // `$&` in a replacement string would otherwise expand to the matched text.
    const output = getInitialHtml("csp-$&-source", { codiconsStyleHref: "style-$'-href" });
    expect(output).toContain("csp-$&-source");
    expect(output).toContain("style-$'-href");
  });

  it("ships an inline script that parses as valid JavaScript", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html())?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script ?? "")).not.toThrow();
  });

  it("renders the toolbar controls the host listens for", () => {
    const output = html();
    for (const id of [
      "btn-direction",
      "btn-expand",
      "btn-collapse",
      "btn-fit",
      "btn-zoom-in",
      "btn-zoom-out",
      "btn-refresh",
    ]) {
      expect(output).toContain(`id="${id}"`);
    }
  });

  it("provides the header and simulation slots the renderer fills in", () => {
    const output = html();
    for (const id of ["title", "triggers", "simulation", "banner", "scene", "message"]) {
      expect(output).toContain(`id="${id}"`);
    }
  });
});
