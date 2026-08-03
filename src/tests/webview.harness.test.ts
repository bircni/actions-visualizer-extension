/**
 * Runs the real webview template in JSDOM with a stubbed `acquireVsCodeApi`, so the
 * renderer is exercised end to end against graphs produced by the real pipeline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraphMessage, type GraphMessageBody } from "../preview/graphMessage.js";
import { getInitialHtml } from "../webview/content.js";
import { parseWorkflow } from "../workflow/parse.js";
import { refChoicesFor, type Simulation } from "../workflow/simulate.js";

const FIXTURE_DIR = path.join(process.cwd(), ".fixtures", "workflows");

type Payload = GraphMessageBody;

/**
 * Builds the exact `graph` message the host would post, through the host's own
 * builder — so this harness cannot drift from what the extension really sends.
 */
function payload(
  name: string,
  options: {
    event?: string;
    expanded?: string[];
    inputs?: Simulation["inputs"];
    pinned?: Record<string, string>;
    ref?: string;
  } = {},
): Payload {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
  const model = parseWorkflow(text);
  const event = options.event ?? model.triggers[0]?.event;
  const trigger = model.triggers.find((candidate) => candidate.event === event);
  const simulation: Simulation = {
    event,
    ref: options.ref ?? refChoicesFor(trigger)[0]?.ref,
    inputs: options.inputs ?? {},
    pinned: options.pinned ?? {},
  };
  return buildGraphMessage(model, {
    fileName: "ci.yml",
    showSteps: true,
    expandMatrix: false,
    direction: "LR",
    simulation,
    expanded: options.expanded ?? [],
  }).body;
}

type DomDocument = JSDOM["window"]["document"];
type DomElement = ReturnType<DomDocument["querySelector"]>;

type Harness = {
  dom: JSDOM;
  document: DomDocument;
  posted: Record<string, unknown>[];
  send: (message: unknown) => void;
  sendGraph: (data: Payload) => void;
  click: (element: DomElement) => void;
};

/** JSDOM has no layout engine, so give every element a usable size. */
function stubBoundingRect(): {
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  x: number;
  y: number;
} {
  return { width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, x: 0, y: 0 };
}

function mount(): Harness {
  const posted: Record<string, unknown>[] = [];
  const dom = new JSDOM(getInitialHtml("vscode-resource://x", { codiconsStyleHref: "" }), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "acquireVsCodeApi", {
        value: () => ({
          postMessage: (message: Record<string, unknown>) => {
            posted.push(message);
          },
          getState: () => {},
          setState: () => {},
        }),
      });
      window.Element.prototype.getBoundingClientRect = stubBoundingRect;
    },
  });

  const { window } = dom;
  const send = (message: unknown): void => {
    window.dispatchEvent(new window.MessageEvent("message", { data: message }));
  };
  const click = (element: DomElement): void => {
    if (!element) {
      throw new Error("cannot click a missing element");
    }
    const options = { bubbles: true, clientX: 10, clientY: 10 };
    element.dispatchEvent(new window.MouseEvent("mousedown", { ...options, button: 0 }));
    element.dispatchEvent(new window.MouseEvent("mouseup", options));
  };

  return {
    dom,
    document: window.document,
    posted,
    send,
    sendGraph: (data) => {
      send({ type: "graph", graph: data.graph, expanded: [], simulation: data.simulation });
    },
    click,
  };
}

let harness: Harness | undefined;

afterEach(() => {
  harness?.dom.window.close();
  harness = undefined;
});

describe("webview bootstrap", () => {
  it("announces itself as ready", () => {
    harness = mount();
    expect(harness.posted).toEqual([{ type: "ready" }]);
  });

  it("draws nothing until a graph arrives", () => {
    harness = mount();
    expect(harness.document.querySelectorAll(".card")).toHaveLength(0);
  });
});

describe("webview header", () => {
  it("shows the workflow name over its triggers, the way GitHub does", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    expect(harness.document.querySelector("#title")?.textContent).toBe("Fan Out");
    const chips = [...harness.document.querySelectorAll("#triggers .chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["push", "pull_request"]);
    expect(harness.document.querySelector("#triggers .label")?.textContent).toBe("on:");
  });

  it("marks the simulated trigger and switches on click", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const chips = [...harness.document.querySelectorAll("#triggers .chip")];
    expect(chips[0]?.className).toContain("selected");
    expect(chips[1]?.className).not.toContain("selected");

    const { window } = harness.dom;
    chips[1]?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "setEvent", value: "pull_request" });
  });

  it("offers an editable ref with the declared filters as suggestions", () => {
    harness = mount();
    harness.sendGraph(payload("dispatch.yml", { event: "push" }));

    const input = harness.document.querySelector("#simulation input.ref");
    expect(input?.value).toBe("refs/heads/main");
    const options = [...harness.document.querySelectorAll("#ref-choices option")];
    expect(options.map((option) => option.value)).toEqual(["refs/heads/main", "refs/heads/dev"]);
  });

  it("reports a typed ref to the host", () => {
    harness = mount();
    harness.sendGraph(payload("dispatch.yml", { event: "push" }));
    const input = harness.document.querySelector("#simulation input.ref");
    const { window } = harness.dom;
    if (input) {
      input.value = "refs/heads/topic";
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    expect(harness.posted).toContainEqual({ type: "setRef", value: "refs/heads/topic" });
  });

  it("renders a control per declared input and reports changes", () => {
    harness = mount();
    harness.sendGraph(payload("dispatch.yml", { event: "workflow_dispatch" }));
    const { window } = harness.dom;

    const choice = harness.document.querySelector("#simulation select");
    expect([...(choice?.querySelectorAll("option") ?? [])].map((o) => o.textContent)).toEqual([
      "staging",
      "production",
    ]);
    if (choice) {
      choice.value = "production";
      choice.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    expect(harness.posted).toContainEqual({
      type: "setInput",
      name: "environment",
      input: "production",
    });

    const toggle = harness.document.querySelector("#simulation input[type=checkbox]");
    expect(toggle?.checked).toBe(true);
    if (toggle) {
      toggle.checked = false;
      toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    expect(harness.posted).toContainEqual({ type: "setInput", name: "dry-run", input: false });
  });

  it("shows only the ref for a workflow with no inputs or unknowns", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml"));
    expect(harness.document.querySelectorAll("#simulation .field")).toHaveLength(1);
    expect(harness.document.querySelector("#simulation input.ref")).toBeTruthy();
  });

  it("hides the simulation bar when the workflow declares no triggers", () => {
    harness = mount();
    harness.sendGraph(payload("no-triggers.yml"));
    expect(harness.document.querySelector("#simulation")?.className).toBe("");
  });
});

describe("webview graph rendering", () => {
  it("draws one card per group with a row per job", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    expect(harness.document.querySelectorAll(".card")).toHaveLength(3);
    expect(harness.document.querySelectorAll(".row")).toHaveLength(4);
    // The middle card holds both `lint` and `test`.
    const cards = [...harness.document.querySelectorAll(".card")];
    expect(cards[1]?.querySelectorAll(".row")).toHaveLength(2);
  });

  it("draws an edge and its two connection dots per card link", () => {
    harness = mount();
    const data = payload("fan-out.yml");
    harness.sendGraph(data);
    expect(harness.document.querySelectorAll("path.edge")).toHaveLength(data.graph.edges.length);
    expect(harness.document.querySelectorAll("circle.edge-dot")).toHaveLength(
      data.graph.edges.length * 2,
    );
  });

  it("gives a matrix card its tab", () => {
    harness = mount();
    harness.sendGraph(payload("matrix.yml"));
    expect(harness.document.querySelector(".card-tab")).toBeTruthy();
    expect(harness.document.querySelector(".card-tab-text")?.textContent).toBe("Matrix: test");
    expect(harness.document.querySelector(".row-title")?.textContent).toBe("4 jobs");
  });

  it("expands a matrix card to a row per combination", () => {
    harness = mount();
    harness.sendGraph(payload("matrix.yml", { expanded: ["card:matrix:test"] }));
    expect(harness.document.querySelectorAll(".row")).toHaveLength(4);
  });

  it("marks a broken dependency card and edge", () => {
    harness = mount();
    harness.sendGraph(payload("missing-needs.yml"));
    expect(harness.document.querySelectorAll(".card.missing")).toHaveLength(1);
    expect(harness.document.querySelectorAll("path.edge.broken")).toHaveLength(1);
  });

  it("renders steps only for an expanded row", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml"));
    expect(harness.document.querySelectorAll(".row-step")).toHaveLength(0);
    harness.sendGraph(payload("simple.yml", { expanded: ["row:build"] }));
    expect(harness.document.querySelectorAll(".row-step")).toHaveLength(2);
  });

  it("shows warnings in a banner", () => {
    harness = mount();
    harness.sendGraph(payload("missing-needs.yml"));
    const banner = harness.document.querySelector("#banner");
    expect(banner?.className).toBe("visible");
    expect(banner?.textContent).toContain("nonexistent");
  });

  it("shows a parse error instead of a graph", () => {
    harness = mount();
    harness.sendGraph(payload("broken.yml"));
    expect(harness.document.querySelector("#message")?.className).toContain("error");
    expect(harness.document.querySelectorAll(".card")).toHaveLength(0);
  });

  it("ignores messages it does not understand", () => {
    harness = mount();
    harness.send({ type: "unknown" });
    harness.send(null);
    harness.send("not an object");
    expect(harness.posted).toEqual([{ type: "ready" }]);
  });
});

describe("webview simulation states", () => {
  it("dims a skipped row in place rather than removing it", () => {
    harness = mount();
    const onPush = payload("conditional.yml", { event: "push" });
    harness.sendGraph(onPush);
    expect(harness.document.querySelectorAll(".row.skipped")).toHaveLength(0);
    const before = [...harness.document.querySelectorAll(".row")].map((row) => row.dataset.rowId);

    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    expect(harness.document.querySelectorAll(".row.skipped")).toHaveLength(1);
    const after = [...harness.document.querySelectorAll(".row")].map((row) => row.dataset.rowId);
    // Same rows, same order: the layout must not jump when a job is skipped.
    expect(after).toEqual(before);
  });

  it("fades the edges into a skipped card", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    expect(harness.document.querySelectorAll("path.edge.inactive").length).toBeGreaterThan(0);
  });

  it("marks an undecidable row as unknown", () => {
    harness = mount();
    harness.sendGraph(payload("unknown-condition.yml"));
    expect(harness.document.querySelectorAll(".row.unknown")).toHaveLength(1);
    expect(harness.document.querySelector(".state-glyph.outline")?.textContent).toBe("?");
  });

  it("explains a row's state on hover", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    const skipped = harness.document.querySelector(".row.skipped title");
    expect(skipped?.textContent).toContain("`if:` is false");
  });
});

describe("webview interaction", () => {
  it("asks the host to reveal the source when a row is clicked", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    harness.click(harness.document.querySelector('[data-row-id="row:build"]'));
    const reveal = harness.posted.find((message) => message["type"] === "revealSource");
    expect(reveal).toMatchObject({ type: "revealSource", nodeId: "row:build" });
    expect(typeof reveal?.["offset"]).toBe("number");
  });

  it("toggles steps on alt-click", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const row = harness.document.querySelector('[data-row-id="row:build"]');
    const { window } = harness.dom;
    row?.dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 5, clientY: 5 }),
    );
    row?.dispatchEvent(
      new window.MouseEvent("mouseup", { bubbles: true, altKey: true, clientX: 5, clientY: 5 }),
    );
    expect(harness.posted).toContainEqual({ type: "toggleExpand", nodeId: "row:build" });
  });

  it("does not treat a drag as a click", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const row = harness.document.querySelector('[data-row-id="row:build"]');
    const { window } = harness.dom;
    row?.dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 80, clientY: 40 }));
    row?.dispatchEvent(
      new window.MouseEvent("mouseup", { bubbles: true, clientX: 80, clientY: 40 }),
    );
    expect(harness.posted.some((message) => message["type"] === "revealSource")).toBe(false);
  });

  it("wires each toolbar button to its message", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const press = (id: string): void => {
      harness?.document
        .querySelector(`#${id}`)
        ?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    };
    press("btn-refresh");
    press("btn-expand");
    press("btn-collapse");
    press("btn-direction");
    expect(harness.posted).toContainEqual({ type: "refresh" });
    expect(harness.posted).toContainEqual({ type: "expandAll" });
    expect(harness.posted).toContainEqual({ type: "collapseAll" });
    expect(harness.posted).toContainEqual({ type: "setDirection", direction: "TB" });
  });

  it("serialises a standalone SVG on request", () => {
    harness = mount();
    const data = payload("fan-out.yml");
    harness.sendGraph(data);
    harness.send({ type: "requestExport" });
    const exported = harness.posted.find((message) => message["type"] === "exportSvg");
    const svg = String(exported?.["svg"]);
    expect(svg).toContain("<?xml");
    expect(svg).toContain(`viewBox="0 0 ${String(data.graph.width)} ${String(data.graph.height)}"`);
    // The export must carry its own styles, since it leaves the webview.
    expect(svg).toContain("<style");
  });

  it("exports nothing when there is no graph", () => {
    harness = mount();
    harness.send({ type: "requestExport" });
    expect(harness.posted).toContainEqual({ type: "exportSvg", svg: "" });
  });

  it("reports an export failure to the user", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    harness.send({ type: "exportResult", success: false, error: "disk full" });
    expect(harness.document.querySelector("#message")?.textContent).toBe("disk full");
  });
});

describe("webview pinning", () => {
  it("offers a field for each value the preview cannot resolve", () => {
    harness = mount();
    harness.sendGraph(payload("unknown-condition.yml"));
    const fields = [...harness.document.querySelectorAll("#simulation .field.pin")];
    expect(fields.map((f) => f.querySelector(".name")?.textContent)).toEqual([
      "secrets.DEPLOY_KEY",
    ]);
    expect(harness.document.querySelector("#simulation")?.className).toBe("visible");
  });

  it("reports a pinned value to the host", () => {
    harness = mount();
    harness.sendGraph(payload("unknown-condition.yml"));
    const control = harness.document.querySelector("#simulation .field.pin input");
    const { window } = harness.dom;
    if (control) {
      control.value = "abc123";
      control.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    expect(harness.posted).toContainEqual({
      type: "setPin",
      name: "secrets.DEPLOY_KEY",
      input: "abc123",
    });
  });

  it("shows a clear button only once a value is pinned", () => {
    harness = mount();
    harness.sendGraph(payload("unknown-condition.yml"));
    expect(harness.document.querySelectorAll(".clear-pin")).toHaveLength(0);

    harness.sendGraph(
      payload("unknown-condition.yml", { pinned: { "secrets.DEPLOY_KEY": "abc" } }),
    );
    const clear = harness.document.querySelector(".clear-pin");
    expect(clear).toBeTruthy();
    clear?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    // Clearing sends no value, which is how the host tells it apart from an empty pin.
    expect(harness.posted).toContainEqual({ type: "setPin", name: "secrets.DEPLOY_KEY" });
  });

  it("dims the steps that would not run", () => {
    harness = mount();
    harness.sendGraph(
      payload("step-conditions.yml", { event: "pull_request", expanded: ["row:a"] }),
    );
    expect(harness.document.querySelectorAll(".row-step.step-skipped")).toHaveLength(1);
    expect(harness.document.querySelectorAll(".row-step.step-run")).toHaveLength(1);
  });
});

describe("webview trigger filters", () => {
  it("warns when the ref would not fire the workflow", () => {
    harness = mount();
    harness.sendGraph(payload("filtered.yml", { ref: "refs/heads/topic" }));
    const banner = harness.document.querySelector("#banner");
    expect(banner?.className).toBe("visible");
    expect(banner?.textContent).toContain("would not fire");
    // Everything is dimmed, since nothing would run.
    expect(harness.document.querySelectorAll(".row.skipped").length).toBeGreaterThan(0);
  });

  it("does not warn for a ref the filters accept", () => {
    harness = mount();
    harness.sendGraph(payload("filtered.yml"));
    expect(harness.document.querySelector("#banner")?.className).toBe("");
    expect(harness.document.querySelectorAll(".row.skipped")).toHaveLength(0);
  });
});

describe("webview accessibility", () => {
  it("exposes cards as lists and rows as focusable list items", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const rows = [...harness.document.querySelectorAll(".row")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute("role")).toBe("listitem");
      expect(row.getAttribute("tabindex")).toBe("0");
    }
    for (const card of harness.document.querySelectorAll(".card")) {
      expect(card.getAttribute("role")).toBe("list");
    }
    expect(harness.document.querySelector("#canvas")?.getAttribute("aria-label")).toBe(
      "Workflow dependency graph",
    );
  });

  it("labels each row with its name, state and runner", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const label = harness.document
      .querySelector('[data-row-id="row:build"]')
      ?.getAttribute("aria-label");
    expect(label).toContain("build");
    expect(label).toContain("would run");
    expect(label).toContain("ubuntu-latest");
  });

  it("says why a row is skipped, without the markdown backticks", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    const label = harness.document.querySelector(".row.skipped")?.getAttribute("aria-label");
    expect(label).toContain("would be skipped");
    expect(label).toContain("if: is false");
    expect(label).not.toContain("`");
  });

  it("reports whether an expandable row is open", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml"));
    expect(
      harness.document.querySelector('[data-row-id="row:build"]')?.getAttribute("aria-label"),
    ).toContain("collapsed");

    harness.sendGraph(payload("simple.yml", { expanded: ["row:build"] }));
    expect(
      harness.document.querySelector('[data-row-id="row:build"]')?.getAttribute("aria-label"),
    ).toContain("expanded");
  });

  it("activates a focused row from the keyboard", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const { window } = harness.dom;
    const row = harness.document.querySelector('[data-row-id="row:build"]');

    row?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(harness.posted).toContainEqual(
      expect.objectContaining({ type: "revealSource", nodeId: "row:build" }),
    );

    row?.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "toggleExpand", nodeId: "row:build" });
  });

  it("leaves the zoom shortcuts working when no row has focus", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const { window } = harness.dom;
    const before = harness.document.querySelector("#scene")?.getAttribute("transform");
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "+" }));
    expect(harness.document.querySelector("#scene")?.getAttribute("transform")).not.toBe(before);
  });
});
