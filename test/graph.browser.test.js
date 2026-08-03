// @ts-check
/**
 * Renders the real webview template in Chromium and drives it like a user would.
 * This covers what JSDOM cannot: real layout, wheel zoom and SVG geometry.
 *
 * The payloads are produced by the real pipeline in `scripts/build-browser-fixture.ts`
 * so the spec never drifts from the shapes the extension host actually posts.
 */

const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const repoRoot = path.resolve(__dirname, "..");
const templatePath = path.join(repoRoot, "src", "webview", "content.html");
const fixturePath = path.join(repoRoot, ".tmp", "browser-fixture.json");

if (!fs.existsSync(fixturePath)) {
  throw new Error(
    `Missing ${fixturePath}. Run \`npm run build:browser-fixture\` (test:e2e does this for you).`,
  );
}

/** @type {Record<string, {graph: any, simulation: any}>} */
const PAYLOADS = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

/**
 * Real VS Code token values for the two default themes. The renderer must stay
 * readable under both; pairing a background token with an unrelated foreground
 * token is an easy way to end up with blue-on-blue text.
 */
const THEMES = {
  light: `--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;
    --vscode-panel-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;
    --vscode-descriptionForeground:#616161;--vscode-textLink-foreground:#005fb8;
    --vscode-testing-iconPassed:#3d8b40;--vscode-editorWarning-foreground:#bf8803;
    --vscode-errorForeground:#e51400;--vscode-badge-background:#3572CE;
    --vscode-badge-foreground:#ffffff;--vscode-input-background:#ffffff;
    --vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;`,
  dark: `--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;
    --vscode-panel-border:#2b2b2b;--vscode-editorWidget-background:#202020;
    --vscode-descriptionForeground:#9d9d9d;--vscode-textLink-foreground:#4daafc;
    --vscode-testing-iconPassed:#73c991;--vscode-editorWarning-foreground:#cca700;
    --vscode-errorForeground:#f85149;--vscode-badge-background:#616161;
    --vscode-badge-foreground:#f8f8f8;--vscode-input-background:#313131;
    --vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;`,
};

/** Loads the template with placeholders filled in and a stubbed VS Code API. */
async function mount(page, theme) {
  const html = fs
    .readFileSync(templatePath, "utf8")
    .replace(/__CSP_SOURCE__/g, "'self'")
    .replace("__CODICONS_STYLE__", "");
  const tokens = theme ? `<style>:root{${THEMES[theme]}}</style>` : "";
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">${tokens}` +
      `<script>window.__posted = []; window.acquireVsCodeApi = function () {` +
      `  return { postMessage: function (m) { window.__posted.push(m); },` +
      `           getState: function () {}, setState: function () {} };` +
      `};</script></head><body>${html}</body></html>`,
    { waitUntil: "load" },
  );
}

/** WCAG contrast ratio between an element's own colour and its background. */
async function contrastOf(page, selector) {
  return page.evaluate((target) => {
    const parse = (value) => {
      const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    const element = document.querySelector(target);
    if (!element) {
      return null;
    }
    const style = getComputedStyle(element);
    const fg = parse(style.color);

    // Walk up until an opaque background is found, the way a browser composites.
    let node = element;
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    while (node) {
      const candidate = parse(getComputedStyle(node).backgroundColor);
      if (candidate.a > 0.95) {
        bg = candidate;
        break;
      }
      node = node.parentElement;
    }

    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selector);
}

async function send(page, message) {
  await page.evaluate((payload) => {
    window.dispatchEvent(new MessageEvent("message", { data: payload }));
  }, message);
}

async function sendGraph(page, name) {
  const payload = PAYLOADS[name];
  expect(payload, `fixture "${name}" should exist`).toBeTruthy();
  await send(page, {
    type: "graph",
    graph: payload.graph,
    expanded: [],
    simulation: payload.simulation,
  });
}

async function resetPosted(page) {
  await page.evaluate(() => {
    window.__posted.length = 0;
  });
}

const scaleOf = async (page) =>
  Number(
    /scale\(([\d.]+)\)/.exec((await page.locator("#scene").getAttribute("transform")) ?? "")?.[1] ??
      "0",
  );

test.describe("workflow graph webview", () => {
  test("announces readiness on load", async ({ page }) => {
    await mount(page);
    expect(await page.evaluate(() => window.__posted)).toEqual([{ type: "ready" }]);
  });

  test("renders the header above the graph, GitHub-style", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    await expect(page.locator("#title")).toHaveText("Fan Out");
    await expect(page.locator("#triggers .label")).toHaveText("on:");
    await expect(page.locator("#triggers .chip")).toHaveCount(2);
    await expect(page.locator("#triggers .chip.selected")).toHaveText("push");

    // The header must sit above the canvas, not float over it.
    const header = await page.locator("#header").boundingBox();
    const viewport = await page.locator("#viewport").boundingBox();
    expect(header.y + header.height).toBeLessThanOrEqual(viewport.y + 1);
  });

  // Regression guard: the selected chip once rendered blue-on-blue because it paired
  // `badge-background` with `textLink-foreground` instead of `badge-foreground`.
  for (const theme of ["light", "dark"]) {
    test(`keeps header text readable on the ${theme} theme`, async ({ page }) => {
      await mount(page, theme);
      await sendGraph(page, "fanOut");

      const selectedChip = await contrastOf(page, "#triggers .chip.selected");
      expect(selectedChip, "selected trigger chip").toBeGreaterThanOrEqual(4.5);

      const unselectedChip = await contrastOf(page, "#triggers .chip:not(.selected)");
      expect(unselectedChip, "unselected trigger chip").toBeGreaterThanOrEqual(4.5);

      expect(await contrastOf(page, "#title"), "workflow title").toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(page, "#triggers .label"), "`on:` label").toBeGreaterThanOrEqual(4.5);
    });
  }

  test("draws cards with real geometry and groups jobs into rows", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");

    await expect(page.locator(".card")).toHaveCount(3);
    await expect(page.locator(".row")).toHaveCount(4);
    await expect(page.locator(".card").nth(1).locator(".row")).toHaveCount(2);

    const boxes = await page
      .locator(".card")
      .evaluateAll((cards) =>
        cards.map((card) => card.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })),
      );
    for (const box of boxes) {
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
    }
  });

  test("anchors the graph to the top left rather than centring it", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    const viewport = await page.locator("#viewport").boundingBox();
    const first = await page.locator(".card").first().boundingBox();
    // The first card should sit near the top of the canvas, the way GitHub does it.
    expect(first.y - viewport.y).toBeLessThan(120);
  });

  test("keeps cards in dependency order left to right", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    const xs = await page
      .locator(".card")
      .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().x));
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });

  test("never overlaps two cards", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "showcase");
    const boxes = await page
      .locator(".card")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const r = card.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }),
      );
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const separated = a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1;
        expect(separated, `cards ${i} and ${j} must not overlap`).toBe(true);
      }
    }
  });

  test("draws each edge with a dot at both ends", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    const edges = PAYLOADS.fanOut.graph.edges.length;
    await expect(page.locator("path.edge")).toHaveCount(edges);
    await expect(page.locator("circle.edge-dot")).toHaveCount(edges * 2);
  });

  test("renders the matrix tab above its card", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "showcase");
    await expect(page.locator(".card-tab-text")).toHaveText("Matrix: test");
    const tab = await page.locator(".card-tab").boundingBox();
    const card = await page.locator(".card.matrix .card-box").boundingBox();
    expect(tab.y).toBeLessThan(card.y);
  });

  test("dims a skipped job in place and fades its edges", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "conditionalPush");
    await expect(page.locator(".row.skipped")).toHaveCount(0);
    const before = await page
      .locator(".row")
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().y));

    await sendGraph(page, "conditionalPr");
    await expect(page.locator(".row.skipped")).toHaveCount(1);
    await expect(page.locator("path.edge.inactive")).toHaveCount(1);

    const after = await page
      .locator(".row")
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().y));
    // Dimming must not move anything.
    expect(after).toEqual(before);
  });

  test("switches the simulated event from the header", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "conditionalPush");
    await resetPosted(page);
    await page.locator("#triggers .chip", { hasText: "pull_request" }).click();
    expect(await page.evaluate(() => window.__posted)).toContainEqual({
      type: "setEvent",
      value: "pull_request",
    });
  });

  test("drives the workflow_dispatch input form", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "dispatch");
    await resetPosted(page);

    await expect(page.locator("#simulation")).toBeVisible();
    await page.locator("#simulation select").selectOption("production");
    await page.locator("#simulation input[type=checkbox]").uncheck();

    const posted = await page.evaluate(() => window.__posted);
    expect(posted).toContainEqual({ type: "setInput", name: "environment", input: "production" });
    expect(posted).toContainEqual({ type: "setInput", name: "dry-run", input: false });
  });

  test("shows steps only once a row is expanded", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "simple");
    await expect(page.locator(".row-step")).toHaveCount(0);
    await sendGraph(page, "simpleExpanded");
    await expect(page.locator(".row-step")).toHaveCount(2);
  });

  test("zooms with the wheel, keeping the pointer anchored", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    const before = await scaleOf(page);
    await page.locator("#viewport").hover();
    await page.mouse.wheel(0, -240);
    expect(await scaleOf(page)).toBeGreaterThan(before);
  });

  test("pans with a drag without treating it as a click", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    await resetPosted(page);

    const box = await page.locator('[data-row-id="row:build"]').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 60, { steps: 5 });
    await page.mouse.up();

    const posted = await page.evaluate(() => window.__posted);
    expect(posted.some((message) => message.type === "revealSource")).toBe(false);
  });

  test("asks the host to reveal the source on a plain click", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    await resetPosted(page);

    await page.locator('[data-row-id="row:build"]').click();
    const posted = await page.evaluate(() => window.__posted);
    const reveal = posted.find((message) => message.type === "revealSource");
    expect(reveal).toMatchObject({ type: "revealSource", nodeId: "row:build" });
    expect(typeof reveal.offset).toBe("number");
  });

  test("shows an error instead of a graph when parsing failed", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "broken");
    await expect(page.locator("#message")).toHaveClass(/error/);
    await expect(page.locator(".card")).toHaveCount(0);
    // The header must survive a parse error so the user keeps their bearings.
    // An unparseable file has no trustworthy `name:`, so it falls back to the file name.
    await expect(page.locator("#title")).toHaveText("broken.yml");
  });

  test("renders warnings in a banner", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "missingNeeds");
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#banner")).toContainText("nonexistent");
  });

  test("exports a standalone SVG carrying its own styles", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    await send(page, { type: "requestExport" });

    const posted = await page.evaluate(() => window.__posted);
    const exported = posted.find((message) => message.type === "exportSvg");
    expect(exported).toBeTruthy();
    expect(exported.svg).toContain("<?xml");
    expect(exported.svg).toContain(
      `viewBox="0 0 ${PAYLOADS.fanOut.graph.width} ${PAYLOADS.fanOut.graph.height}"`,
    );
    expect(exported.svg).toContain("<style");
    // The export must not carry the interactive pan/zoom transform.
    expect(exported.svg).not.toContain('id="scene" transform');
  });

  test("drives every toolbar button", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    await resetPosted(page);

    await page.locator("#btn-expand").click();
    await page.locator("#btn-collapse").click();
    await page.locator("#btn-direction").click();
    await page.locator("#btn-refresh").click();

    const posted = await page.evaluate(() => window.__posted);
    expect(posted).toContainEqual({ type: "expandAll" });
    expect(posted).toContainEqual({ type: "collapseAll" });
    expect(posted).toContainEqual({ type: "setDirection", direction: "TB" });
    expect(posted).toContainEqual({ type: "refresh" });
  });

  test("zooms and fits with the keyboard", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "fanOut");
    const fitted = await scaleOf(page);
    await page.keyboard.press("+");
    expect(await scaleOf(page)).toBeGreaterThan(fitted);
    await page.keyboard.press("0");
    expect(await scaleOf(page)).toBeCloseTo(fitted, 5);
  });

  test("leaves the keyboard alone while an input has focus", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "dispatch");
    const fitted = await scaleOf(page);
    await page.locator("#simulation select").focus();
    await page.keyboard.press("+");
    // Typing in the form must not zoom the graph.
    expect(await scaleOf(page)).toBeCloseTo(fitted, 5);
  });

  test("offers a field for each unresolved value and reports it", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "gated");
    await resetPosted(page);

    await expect(page.locator("#simulation .field.pin")).toHaveCount(1);
    await expect(page.locator("#simulation .field.pin .name")).toHaveText("secrets.DEPLOY_KEY");

    await page.locator("#simulation .field.pin input").fill("abc123");
    await page.locator("#simulation .field.pin input").blur();
    expect(await page.evaluate(() => window.__posted)).toContainEqual({
      type: "setPin",
      name: "secrets.DEPLOY_KEY",
      input: "abc123",
    });
  });

  test("clears a pinned value from its own button", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "gated");
    await expect(page.locator(".clear-pin")).toHaveCount(0);

    await sendGraph(page, "gatedPinned");
    await resetPosted(page);
    await page.locator(".clear-pin").click();
    // Clearing sends no value at all, which is how the host tells it apart from
    // pinning the empty string.
    expect(await page.evaluate(() => window.__posted)).toContainEqual({
      type: "setPin",
      name: "secrets.DEPLOY_KEY",
    });
  });

  test("dims steps that would not run", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "stepConditions");
    await expect(page.locator(".row-step")).toHaveCount(2);
    await expect(page.locator(".row-step.step-skipped")).toHaveCount(1);
    await expect(page.locator(".row-step.step-run")).toHaveCount(1);
  });

  test("lets the ref be typed and suggests the declared filters", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "filtered");
    await resetPosted(page);

    const input = page.locator("#simulation input.ref");
    await expect(input).toHaveValue("refs/heads/main");
    await expect(page.locator("#ref-choices option")).toHaveCount(2);

    await input.fill("refs/heads/topic");
    await input.blur();
    expect(await page.evaluate(() => window.__posted)).toContainEqual({
      type: "setRef",
      value: "refs/heads/topic",
    });
  });

  test("says so when the ref would not fire the workflow", async ({ page }) => {
    await mount(page);
    await sendGraph(page, "filtered");
    await expect(page.locator("#banner")).toBeHidden();
    await expect(page.locator(".row.skipped")).toHaveCount(0);

    await sendGraph(page, "filteredMiss");
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#banner")).toContainText("would not fire");
    // Nothing runs, so every row is dimmed.
    await expect(page.locator(".row.skipped")).toHaveCount(2);
  });
});
