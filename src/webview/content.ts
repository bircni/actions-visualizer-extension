/**
 * Loads the webview template and fills in its placeholders.
 *
 * The template is a single HTML file with an inline script, copied to
 * `dist/webview/` at build time by `scripts/copy-webview.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const TEMPLATE_FILE = "content.html";
const TEMPLATE_SEARCH_PATHS = [
  path.join(__dirname, TEMPLATE_FILE),
  path.join(__dirname, "webview", TEMPLATE_FILE),
  path.join(process.cwd(), "src", "webview", TEMPLATE_FILE),
  path.join(process.cwd(), "dist", "webview", TEMPLATE_FILE),
];

function getTemplateHtml(): string {
  for (const templatePath of TEMPLATE_SEARCH_PATHS) {
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, "utf8");
    }
  }
  throw new Error(`Missing webview template: ${TEMPLATE_FILE}`);
}

export type InitialHtmlOptions = {
  /** Webview URI to `dist/webview/codicon.css`, required for the toolbar and step icons. */
  codiconsStyleHref?: string;
};

/**
 * Builds the webview HTML.
 * @param cspSource - Webview `cspSource`, required so the inline script and styles run.
 */
export function getInitialHtml(cspSource: string, options?: InitialHtmlOptions): string {
  const codiconsStyleHref = options?.codiconsStyleHref ?? "";
  // Replacements are passed as functions so `$&`, `$'` and friends inside a value
  // are inserted verbatim instead of being treated as substitution patterns.
  return getTemplateHtml()
    .replaceAll("__CSP_SOURCE__", () => cspSource)
    .replace("__CODICONS_STYLE__", () => codiconsStyleHref);
}
