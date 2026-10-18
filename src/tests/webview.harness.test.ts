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
import { newPlaythrough, type Playthrough, type StepDecision } from "../workflow/playthrough.js";

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
    playthrough?: Playthrough;
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
    playthrough: options.playthrough,
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
      send({ type: "graph", ...data });
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
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toContain("nonexistent");
    // Backticked names from the host render as code, not as literal backticks.
    expect(banner?.querySelector("code")?.textContent).toBe("deploy");
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
    expect(harness.document.querySelector(".row.unknown .icon-glyph")?.textContent).toBe("?");
  });

  it("explains a row's state on hover", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    const skipped = harness.document.querySelector(".row.skipped > title");
    // A tooltip is plain text, so the host's markdown backticks are dropped.
    expect(skipped?.textContent).toContain("if: is false");
    expect(skipped?.textContent).not.toContain("`");
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
    press("btn-steps");
    press("btn-direction");
    press("btn-export");
    expect(harness.posted).toContainEqual({ type: "refresh" });
    // Nothing is expanded yet, so the one steps button expands everything.
    expect(harness.posted).toContainEqual({ type: "expandAll" });
    expect(harness.posted).toContainEqual({ type: "setDirection", direction: "TB" });
    const exported = harness.posted.find((message) => message["type"] === "exportSvg");
    expect(String(exported?.["svg"])).toContain("<svg");
  });

  it("collapses every row from the same steps button once any is expanded", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml", { expanded: ["row:build"] }));
    harness.document
      .querySelector("#btn-steps")
      ?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "collapseAll" });
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
    expect(harness.document.querySelector("#simulation")?.hidden).toBe(false);
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
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toContain("would not fire");
    // Everything is dimmed, since nothing would run.
    expect(harness.document.querySelectorAll(".row.skipped").length).toBeGreaterThan(0);
  });

  it("does not warn for a ref the filters accept", () => {
    harness = mount();
    harness.sendGraph(payload("filtered.yml"));
    expect(harness.document.querySelector("#banner")?.hidden).toBe(true);
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

const WALK = "playthrough.yml";

function walking(decisions: StepDecision[] = []): Playthrough {
  return { ...newPlaythrough(), decisions };
}

function decide(jobId: string, stepIndex: number, outcome: StepDecision["outcome"]): StepDecision {
  return { jobId, stepIndex, outcome, outputs: {} };
}

describe("webview playthrough", () => {
  it("keeps the bar hidden until a walk is running", () => {
    harness = mount();
    harness.sendGraph(payload(WALK));
    expect(harness.document.querySelector("#playthrough")?.hidden).toBe(true);
  });

  it("replaces the simulation controls with the playthrough bar", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking() }));
    // Changing the event mid-walk would invalidate it, so those controls go away.
    expect(harness.document.querySelector("#controls")?.hidden).toBe(true);
    expect(harness.document.querySelector("#playthrough")?.hidden).toBe(false);
  });

  it("says where the walk is and how far along", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking() }));
    expect(harness.document.querySelector("#playthrough .position")?.textContent).toContain(
      "build",
    );
    expect(harness.document.querySelector("#playthrough .progress")?.textContent).toBe(
      "0 of 7 steps",
    );
  });

  it("offers both outcomes and reports the one chosen", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking() }));
    const { window } = harness.dom;

    harness.document
      .querySelector("#outcome-success")
      ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({
      type: "decideStep",
      outcome: "success",
      outputs: {},
    });

    harness.document
      .querySelector("#outcome-failure")
      ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({
      type: "decideStep",
      outcome: "failure",
      outputs: {},
    });
  });

  it("offers a field per discovered output and sends what was typed", () => {
    harness = mount();
    // Step 1 is `Read version`, whose script writes `version`.
    harness.sendGraph(payload(WALK, { playthrough: walking([decide("build", 0, "success")]) }));
    const field = harness.document.querySelector("#playthrough input[data-output]");
    expect(field?.dataset.output).toBe("version");

    const { window } = harness.dom;
    if (field) {
      field.value = "1.4.2";
    }
    harness.document
      .querySelector("#outcome-success")
      ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({
      type: "decideStep",
      outcome: "success",
      outputs: { version: "1.4.2" },
    });
  });

  it("wires the walk controls", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking([decide("build", 0, "success")]) }));
    const { window } = harness.dom;
    const press = (id: string): void => {
      harness?.document
        .querySelector(`#${id}`)
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    };
    press("skip-job");
    press("undo-step");
    press("restart-playthrough");
    press("stop-playthrough");
    expect(harness.posted).toContainEqual({ type: "skipJobRest" });
    expect(harness.posted).toContainEqual({ type: "undoStep" });
    expect(harness.posted).toContainEqual({ type: "restartPlaythrough" });
    expect(harness.posted).toContainEqual({ type: "stopPlaythrough" });
  });

  it("hides undo until there is something to undo", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking() }));
    expect(harness.document.querySelector("#undo-step")).toBeNull();
  });

  it("starts a walk from the toolbar", () => {
    harness = mount();
    harness.sendGraph(payload(WALK));
    harness.document
      .querySelector("#btn-play")
      ?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "startPlaythrough" });
  });

  it("leaves stopping to the walk's own bar, so there is one Stop", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking() }));
    expect(harness.document.querySelector("#btn-play")?.hidden).toBe(true);
    harness.document
      .querySelector("#stop-playthrough")
      ?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "stopPlaythrough" });
    expect(harness.document.querySelectorAll("button[id$='stop-playthrough']")).toHaveLength(1);
  });

  it("marks the current, decided and unreached rows differently", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking([decide("build", 0, "success")]) }));
    expect(harness.document.querySelectorAll(".row.current")).toHaveLength(1);
    expect(harness.document.querySelectorAll(".row.pending").length).toBeGreaterThan(0);
  });

  it("marks the failed step and moves on to the one the failure lets through", () => {
    harness = mount();
    harness.sendGraph(
      payload(WALK, {
        expanded: ["row:build"],
        playthrough: walking([
          decide("build", 0, "success"),
          decide("build", 1, "success"),
          decide("build", 2, "failure"),
        ]),
      }),
    );
    expect(harness.document.querySelectorAll(".row-step.step-failure")).toHaveLength(1);
    // `Upload logs` is `if: failure()`, so the failure is exactly what lets it run.
    expect(harness.document.querySelectorAll(".row-step.step-current")).toHaveLength(1);
    // The job is not failed yet — it is still being walked.
    expect(harness.document.querySelectorAll(".row.current")).toHaveLength(1);
    expect(harness.document.querySelectorAll(".row.failure")).toHaveLength(0);
  });

  it("shows the job failed once its steps are done, and skips what depended on it", () => {
    harness = mount();
    harness.sendGraph(
      payload(WALK, {
        playthrough: walking([
          decide("build", 0, "success"),
          decide("build", 1, "success"),
          decide("build", 2, "failure"),
          decide("build", 3, "success"),
          decide("build", 4, "success"),
        ]),
      }),
    );
    const rowState = (jobId: string): string | undefined =>
      harness?.document.querySelector(`[data-row-id="row:${jobId}"]`)?.getAttribute("class");

    expect(rowState("build")).toContain("failure");
    // `publish` needs build, so it never starts; `notify` is `if: always()`.
    expect(rowState("publish")).toContain("skipped");
    expect(rowState("notify")).toContain("current");
  });

  it("describes the playthrough state to a screen reader", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking() }));
    const label = harness.document
      .querySelector('[data-row-id="row:build"]')
      ?.getAttribute("aria-label");
    expect(label).toContain("waiting for you to say what happened");
  });
});

function rowElement(id: string): ReturnType<DomDocument["querySelector"]> {
  return harness?.document.querySelector(`[data-row-id="${id}"]`) ?? null;
}

function inspectorElement(): DomElement {
  return harness?.document.querySelector("#inspector");
}

describe("webview inspector", () => {
  const row = rowElement;
  const inspector = inspectorElement;

  it("stays closed until a job is chosen", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    expect(inspector()?.hidden).toBe(true);
  });

  it("describes a clicked job: its condition, neighbours, runner and environment", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    harness.click(row("row:publish"));

    expect(inspector()?.hidden).toBe(false);
    expect(row("row:publish")?.getAttribute("class")).toContain("selected");
    const text = inspector()?.textContent ?? "";
    expect(inspector()?.querySelector("h2")?.textContent).toBe("publish");
    expect(text).toContain("github.ref == 'refs/heads/main'");
    expect(text).toContain("production");
    expect(text).toContain("ubuntu-latest");
    const terms = [...(inspector()?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent);
    expect(terms).toEqual(["Condition", "Needs", "Needed by", "Runs on", "Environment"]);
    // The click still jumps to the YAML, as it always has.
    expect(harness.posted).toContainEqual(
      expect.objectContaining({ type: "revealSource", nodeId: "row:publish" }),
    );
  });

  it("lists a matrix's axes and how many jobs it makes", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    harness.click(row("row:test"));
    const text = inspector()?.textContent ?? "";
    expect(text).toContain("os: ubuntu-latest, macos-latest");
    expect(text).toContain("4 combinations");
    // A collapsed matrix row is titled by its count; the inspector names the job.
    expect(inspector()?.querySelector("h2")?.textContent).toBe("4 jobs");
    expect(inspector()?.querySelector(".job-id")?.textContent).toBe("test");
  });

  it("expands a matrix into a row per job, and back", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    harness.click(row("row:test"));
    const toggle = inspector()?.querySelector("#inspector-matrix");
    expect(toggle?.textContent).toBe("Show all 4 jobs");
    toggle?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "toggleExpand", nodeId: "card:matrix:test" });

    // Once expanded, the inspector follows the job onto one of its rows.
    harness.sendGraph(payload("showcase.yml", { expanded: ["card:matrix:test"] }));
    expect(inspector()?.querySelector("#inspector-matrix")?.textContent).toBe("Show as one row");
  });

  it("moves to a neighbouring job from its link", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    harness.click(row("row:publish"));
    const link = [...(inspector()?.querySelectorAll("button.link") ?? [])].find(
      (button) => button.textContent === "notify",
    );
    link?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(inspector()?.querySelector("h2")?.textContent).toBe("notify");
    expect(row("row:notify")?.getAttribute("class")).toContain("selected");
    expect(row("row:publish")?.getAttribute("class")).not.toContain("selected");
  });

  it("lights up the selected job's dependency path, and only that", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    expect(harness.document.querySelectorAll("path.edge.on-path")).toHaveLength(0);
    harness.click(row("row:notify"));
    // notify ← publish ← (test, build) ← lint/typecheck: every edge is upstream.
    const edges = harness.document.querySelectorAll("path.edge").length;
    expect(harness.document.querySelectorAll("path.edge.on-path")).toHaveLength(edges);

    harness.click(row("row:build"));
    // build sits between the lint card and publish; the test card's edges are not its own.
    const lit = harness.document.querySelectorAll("path.edge.on-path").length;
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(edges);
  });

  it("goes to a step's own line in the YAML", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml"));
    harness.click(row("row:build"));
    harness.posted.length = 0;
    const steps = inspector()?.querySelectorAll(".step-item") ?? [];
    expect(steps).toHaveLength(2);
    steps[1]?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    const reveal = harness.posted.find((message) => message["type"] === "revealSource");
    const jobReveal = payload("simple.yml").graph.cards[0]?.rows[0]?.range?.start ?? 0;
    expect(Number(reveal?.["offset"])).toBeGreaterThan(jobReveal);
  });

  it("goes to a step's line from an expanded row in the graph too", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml", { expanded: ["row:build"] }));
    harness.click(
      harness.document.querySelector('[data-row-id="row:build"] [data-step-index="1"]'),
    );
    const reveal = harness.posted.find((message) => message["type"] === "revealSource");
    expect(reveal).toMatchObject({ nodeId: "row:build" });
    expect(harness.posted.some((message) => message["type"] === "toggleExpand")).toBe(false);
  });

  it("opens a local reusable workflow the job calls", () => {
    harness = mount();
    harness.sendGraph(payload("reusable.yml"));
    harness.click(row("row:call"));
    const open = [...(inspector()?.querySelectorAll("button.link") ?? [])].find(
      (button) => button.textContent === "Open",
    );
    open?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({
      type: "openReference",
      value: "./.github/workflows/simple.yml",
    });
  });

  it("plays just the inspected job", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml"));
    harness.click(row("row:build"));
    inspector()
      ?.querySelector("#inspector-play")
      ?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(harness.posted).toContainEqual({ type: "startPlaythrough", nodeId: "build" });
  });

  it("closes on Escape, and on a click on empty canvas", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    harness.click(row("row:publish"));
    const { window } = harness.dom;
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(inspector()?.hidden).toBe(true);

    harness.click(row("row:publish"));
    harness.click(harness.document.querySelector("#canvas"));
    expect(inspector()?.hidden).toBe(true);
  });

  it("keeps showing the same job across a re-render", () => {
    harness = mount();
    harness.sendGraph(payload("showcase.yml"));
    harness.click(row("row:publish"));
    harness.sendGraph(payload("showcase.yml", { event: "pull_request" }));
    expect(inspector()?.querySelector("h2")?.textContent).toBe("publish");
    // On a pull request the condition is false, and the inspector says why.
    expect(inspector()?.textContent).toContain("Would be skipped");
  });

  it("toggles steps from the chevron without jumping to the YAML", () => {
    harness = mount();
    harness.sendGraph(payload("simple.yml"));
    harness.click(harness.document.querySelector('[data-row-id="row:build"] .chevron'));
    expect(harness.posted).toContainEqual({ type: "toggleExpand", nodeId: "row:build" });
    expect(harness.posted.some((message) => message["type"] === "revealSource")).toBe(false);
  });
});

describe("webview status bar and controls", () => {
  it("counts the jobs by what would happen to them", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    const summary = harness.document.querySelector("#summary")?.textContent ?? "";
    expect(summary).toContain("would run");
    expect(summary).toContain("1 skipped");
  });

  it("calls the ref the base branch for a pull request", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "push" }));
    expect(harness.document.querySelector("#simulation .field .name")?.textContent).toBe("ref");
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    expect(harness.document.querySelector("#simulation .field .name")?.textContent).toBe("base");
  });

  it("marks the simulated trigger as the checked option of a radio group", () => {
    harness = mount();
    harness.sendGraph(payload("conditional.yml", { event: "pull_request" }));
    const checked = harness.document.querySelectorAll(
      '#triggers [role="radio"][aria-checked="true"]',
    );
    expect([...checked].map((chip) => chip.textContent)).toEqual(["pull_request"]);
  });

  it("folds a long list of warnings behind a toggle", () => {
    harness = mount();
    const many = payload("missing-needs.yml");
    harness.sendGraph({
      ...many,
      graph: { ...many.graph, warnings: ["first", "second", "third", "fourth"] },
    });
    const banner = harness.document.querySelector("#banner");
    expect(banner?.querySelectorAll(".banner-row")).toHaveLength(2);
    banner
      ?.querySelector("#banner-toggle")
      ?.dispatchEvent(new harness.dom.window.Event("click", { bubbles: true }));
    expect(banner?.querySelectorAll(".banner-row")).toHaveLength(4);
  });

  it("pans on a plain scroll and zooms on a Ctrl-scroll", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const { window } = harness.dom;
    const viewport = harness.document.querySelector("#viewport");
    const transform = () =>
      harness?.document.querySelector("#scene")?.getAttribute("transform") ?? "";
    const scale = () => /scale\(([\d.]+)\)/.exec(transform())?.[1];

    const before = scale();
    viewport?.dispatchEvent(
      new window.WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }),
    );
    expect(scale()).toBe(before);
    expect(transform()).toContain("-100)");

    viewport?.dispatchEvent(
      new window.WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(Number(scale())).toBeGreaterThan(Number(before));
  });

  it("shows the keyboard shortcuts on ? and hides them on Escape", () => {
    harness = mount();
    harness.sendGraph(payload("fan-out.yml"));
    const { window } = harness.dom;
    const panel = harness.document.querySelector("#shortcuts");
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "?" }));
    expect(panel?.hidden).toBe(false);
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel?.hidden).toBe(true);
  });

  it("answers a playthrough step from the keyboard", () => {
    harness = mount();
    harness.sendGraph(payload(WALK, { playthrough: walking([decide("build", 0, "success")]) }));
    const { window } = harness.dom;
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f" }));
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "s" }));
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace" }));
    expect(harness.posted).toContainEqual({ type: "decideStep", outcome: "failure", outputs: {} });
    expect(harness.posted).toContainEqual({ type: "decideStep", outcome: "success", outputs: {} });
    expect(harness.posted).toContainEqual({ type: "undoStep" });
  });

  it("leaves letters alone outside a playthrough", () => {
    harness = mount();
    harness.sendGraph(payload(WALK));
    const { window } = harness.dom;
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "s" }));
    expect(harness.posted.some((message) => message["type"] === "decideStep")).toBe(false);
  });
});
