import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewController,
  type HostWebviewMessage,
  type PreviewDeps,
} from "../preview/previewController.js";
import type { PreviewSettings } from "../preview/previewConfig.js";

const FIXTURE_DIR = path.join(process.cwd(), ".fixtures", "workflows");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

const BASE_SETTINGS: PreviewSettings = {
  showSteps: "collapsed",
  expandMatrix: false,
  direction: "LR",
  liveUpdate: true,
  updateDelayMs: 0,
};

const DISPATCH = [
  "name: Dispatch",
  "on:",
  "  push:",
  "    branches: [main, dev]",
  "  workflow_dispatch:",
  "    inputs:",
  "      deploy:",
  "        type: boolean",
  "        default: false",
  "jobs:",
  "  build:",
  "    steps:",
  "      - run: npm run build",
  "  ship:",
  "    needs: build",
  "    if: inputs.deploy",
  "    steps:",
  "      - run: npm publish",
].join("\n");

type Harness = {
  deps: PreviewDeps;
  posted: HostWebviewMessage[];
  revealed: number[];
  setText: (text: string) => void;
  setSettings: (settings: Partial<PreviewSettings>) => void;
  saveSvg: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
};

function harness(initialText = fixture("fan-out.yml")): Harness {
  let text = initialText;
  let settings: PreviewSettings = { ...BASE_SETTINGS };
  const posted: HostWebviewMessage[] = [];
  const revealed: number[] = [];
  const saveSvg = vi.fn(async () => "/tmp/graph.svg");
  const logError = vi.fn();

  return {
    posted,
    revealed,
    saveSvg,
    logError,
    setText: (next) => {
      text = next;
    },
    setSettings: (next) => {
      settings = { ...settings, ...next };
    },
    deps: {
      readText: () => text,
      readPath: () => "/repo/.github/workflows/fan-out.yml",
      readSettings: () => settings,
      postMessage: (message) => {
        posted.push(message);
        return true;
      },
      revealSource: (offset) => {
        revealed.push(offset);
      },
      saveSvg,
      logInfo: () => {},
      logError,
    },
  };
}

function lastGraph(posted: HostWebviewMessage[]): Extract<HostWebviewMessage, { type: "graph" }> {
  const last = posted.findLast((message) => message.type === "graph");
  if (!last) {
    throw new Error("no graph was posted");
  }
  return last;
}

/** Row states keyed by job id, for compact assertions. */
function rowStates(posted: HostWebviewMessage[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const card of lastGraph(posted).graph.cards) {
    for (const row of card.rows) {
      result[row.jobId] = row.state;
    }
  }
  return result;
}

describe("createPreviewController rendering", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("posts a positioned card graph on render", async () => {
    const controller = createPreviewController(h.deps);
    await controller.render();
    const message = lastGraph(h.posted);
    expect(message.graph.cards).toHaveLength(3);
    expect(message.graph.direction).toBe("LR");
    expect(message.graph.header.fileName).toBe("fan-out.yml");
  });

  it("renders on `ready` and on `refresh`", async () => {
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({ type: "refresh" });
    expect(h.posted.filter((message) => message.type === "graph")).toHaveLength(2);
  });

  it("re-reads settings on every render", async () => {
    const matrix = harness(fixture("matrix.yml"));
    const controller = createPreviewController(matrix.deps);
    await controller.render();
    expect(lastGraph(matrix.posted).graph.cards[0]?.rows).toHaveLength(1);
    matrix.setSettings({ expandMatrix: true });
    await controller.render();
    expect(lastGraph(matrix.posted).graph.cards[0]?.rows).toHaveLength(4);
  });

  it("reports a parse error inside the graph rather than throwing", async () => {
    const broken = harness(fixture("broken.yml"));
    const controller = createPreviewController(broken.deps);
    await controller.render();
    expect(lastGraph(broken.posted).graph.error).toBeTruthy();
  });
});

describe("createPreviewController simulation", () => {
  it("selects the first declared trigger on the first render", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.render();
    expect(lastGraph(h.posted).simulation.event).toBe("push");
    expect(controller.getState().simulation.event).toBe("push");
  });

  it("picks a ref from the event's branch filters", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.render();
    const simulation = lastGraph(h.posted).simulation;
    expect(simulation.ref).toBe("refs/heads/main");
    expect(simulation.refChoices.map((choice) => choice.label)).toEqual(["main", "dev"]);
  });

  it("switches event and re-evaluates every job", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.render();
    // `ship` needs `inputs.deploy`, which does not exist for a push.
    expect(rowStates(h.posted)["ship"]).toBe("skipped");

    await controller.handleMessage({ type: "setEvent", value: "workflow_dispatch" });
    expect(lastGraph(h.posted).simulation.event).toBe("workflow_dispatch");
    expect(rowStates(h.posted)["ship"]).toBe("skipped");

    await controller.handleMessage({ type: "setInput", name: "deploy", input: true });
    expect(rowStates(h.posted)["ship"]).toBe("run");
  });

  it("exposes the inputs the selected event declares", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.render();
    expect(lastGraph(h.posted).simulation.inputs).toEqual([]);

    await controller.handleMessage({ type: "setEvent", value: "workflow_dispatch" });
    const simulation = lastGraph(h.posted).simulation;
    expect(simulation.inputs.map((input) => input.name)).toEqual(["deploy"]);
    expect(simulation.values).toEqual({ deploy: false });
  });

  it("coerces an input value to its declared type", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setEvent", value: "workflow_dispatch" });
    await controller.handleMessage({ type: "setInput", name: "deploy", input: "true" });
    expect(lastGraph(h.posted).simulation.values).toEqual({ deploy: true });
  });

  it("ignores an input the selected event does not declare", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "setInput", name: "nope", input: "x" });
    await controller.handleMessage({ type: "setInput", input: "x" });
    expect(controller.getState().simulation.inputs).toEqual({});
  });

  it("changes the ref and re-evaluates", async () => {
    const source = [
      "on:",
      "  push:",
      "    branches: [main, dev]",
      "jobs:",
      "  ship:",
      "    if: github.ref == 'refs/heads/main'",
    ].join("\n");
    const h = harness(source);
    const controller = createPreviewController(h.deps);
    await controller.render();
    expect(rowStates(h.posted)["ship"]).toBe("run");

    await controller.handleMessage({ type: "setRef", value: "refs/heads/dev" });
    expect(rowStates(h.posted)["ship"]).toBe("skipped");
  });

  it("drops a selection whose trigger the user has deleted", async () => {
    const h = harness(DISPATCH);
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setEvent", value: "workflow_dispatch" });
    await controller.handleMessage({ type: "setInput", name: "deploy", input: true });

    h.setText("on: pull_request\njobs:\n  build:\n    steps: []\n");
    await controller.render();
    expect(controller.getState().simulation).toEqual({
      event: "pull_request",
      ref: "refs/heads/main",
      inputs: {},
      pinned: {},
    });
  });
});

describe("createPreviewController pinning", () => {
  const GATED = [
    "on: push",
    "jobs:",
    "  deploy:",
    "    if: secrets.DEPLOY_KEY != ''",
    "    steps:",
    "      - run: deploy",
  ].join("\n");

  it("offers every unresolved path the conditions depend on", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.render();
    expect(lastGraph(h.posted).simulation.pinnable).toEqual(["secrets.DEPLOY_KEY"]);
    expect(rowStates(h.posted)["deploy"]).toBe("unknown");
  });

  it("decides the condition once a value is pinned", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.render();

    await controller.handleMessage({
      type: "setPin",
      name: "secrets.DEPLOY_KEY",
      input: "abc123",
    });
    expect(rowStates(h.posted)["deploy"]).toBe("run");
    expect(lastGraph(h.posted).simulation.pinned).toEqual({ "secrets.DEPLOY_KEY": "abc123" });
  });

  it("treats an empty string as a real pin, not a clear", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setPin", name: "secrets.DEPLOY_KEY", input: "" });
    // `secrets.X != ''` is false for an empty secret, which is a decision.
    expect(rowStates(h.posted)["deploy"]).toBe("skipped");
  });

  it("keeps a pinned path listed so its field does not vanish", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setPin", name: "secrets.DEPLOY_KEY", input: "x" });
    expect(lastGraph(h.posted).simulation.pinnable).toEqual(["secrets.DEPLOY_KEY"]);
  });

  it("clears a pin when no value is sent", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setPin", name: "secrets.DEPLOY_KEY", input: "x" });
    expect(rowStates(h.posted)["deploy"]).toBe("run");

    await controller.handleMessage({ type: "setPin", name: "secrets.DEPLOY_KEY" });
    expect(rowStates(h.posted)["deploy"]).toBe("unknown");
    expect(lastGraph(h.posted).simulation.pinned).toEqual({});
  });

  it("ignores a pin with no path", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "setPin", input: "x" });
    expect(h.posted.filter((message) => message.type === "graph")).toHaveLength(1);
  });

  it("drops pins when the simulated event changes", async () => {
    const h = harness(GATED);
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setPin", name: "secrets.DEPLOY_KEY", input: "x" });
    await controller.handleMessage({ type: "setEvent", value: "push" });
    // Pins belong to the contexts of the event they were made under.
    expect(lastGraph(h.posted).simulation.pinned).toEqual({});
  });
});

describe("createPreviewController expansion", () => {
  it("toggles a row open and closed", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "toggleExpand", nodeId: "row:build" });
    expect(lastGraph(h.posted).expanded).toEqual(["row:build"]);
    await controller.handleMessage({ type: "toggleExpand", nodeId: "row:build" });
    expect(lastGraph(h.posted).expanded).toEqual([]);
  });

  it("toggles a matrix card open to show its combinations", async () => {
    const h = harness(fixture("matrix.yml"));
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "toggleExpand", nodeId: "card:matrix:test" });
    expect(lastGraph(h.posted).graph.cards[0]?.rows).toHaveLength(4);
  });

  it("ignores a toggle with no id", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "toggleExpand" });
    expect(h.posted.filter((message) => message.type === "graph")).toHaveLength(1);
  });

  it("expands and collapses everything that can expand", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "expandAll" });
    expect(lastGraph(h.posted).expanded.toSorted()).toEqual([
      "row:build",
      "row:lint",
      "row:publish",
      "row:test",
    ]);
    await controller.handleMessage({ type: "collapseAll" });
    expect(lastGraph(h.posted).expanded).toEqual([]);
  });

  it("starts fully expanded when the setting says so", async () => {
    const h = harness();
    h.setSettings({ showSteps: "expanded" });
    const controller = createPreviewController(h.deps);
    await controller.render();
    expect(lastGraph(h.posted).expanded).toHaveLength(4);
  });

  it("drops expansion state for a job that no longer exists", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.render();
    await controller.handleMessage({ type: "toggleExpand", nodeId: "row:build" });
    h.setText("on: push\njobs:\n  renamed:\n    steps:\n      - run: echo 1\n");
    await controller.render();
    expect(lastGraph(h.posted).expanded).toEqual([]);
  });
});

describe("createPreviewController direction", () => {
  it("overrides the configured direction and keeps it across renders", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setDirection", direction: "TB" });
    expect(lastGraph(h.posted).graph.direction).toBe("TB");
    await controller.render();
    expect(lastGraph(h.posted).graph.direction).toBe("TB");
    expect(controller.getState().direction).toBe("TB");
  });

  it("treats an unknown direction as left-to-right", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "setDirection", direction: "sideways" });
    expect(lastGraph(h.posted).graph.direction).toBe("LR");
  });
});

describe("createPreviewController source reveal", () => {
  it("forwards a valid offset", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "revealSource", offset: 42 });
    expect(h.revealed).toEqual([42]);
  });

  it("ignores a missing or negative offset", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "revealSource" });
    await controller.handleMessage({ type: "revealSource", offset: -1 });
    expect(h.revealed).toEqual([]);
  });
});

describe("createPreviewController export", () => {
  it("asks the webview for its SVG", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.requestExport();
    expect(h.posted.at(-1)).toEqual({ type: "requestExport" });
  });

  it("saves the SVG and reports the path", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "exportSvg", svg: "<svg />" });
    expect(h.saveSvg).toHaveBeenCalledWith("<svg />", "fan-out.svg");
    expect(h.posted.at(-1)).toEqual({
      type: "exportResult",
      success: true,
      path: "/tmp/graph.svg",
    });
  });

  it("refuses to export an empty graph", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "exportSvg", svg: "" });
    expect(h.saveSvg).not.toHaveBeenCalled();
    expect(h.posted.at(-1)).toMatchObject({ type: "exportResult", success: false });
  });

  it("stays quiet when the save dialog is dismissed", async () => {
    const h = harness();
    h.saveSvg.mockResolvedValueOnce();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "exportSvg", svg: "<svg />" });
    expect(h.posted).toEqual([]);
  });

  it("reports a write failure instead of throwing", async () => {
    const h = harness();
    h.saveSvg.mockRejectedValueOnce(new Error("disk full"));
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "exportSvg", svg: "<svg />" });
    expect(h.posted.at(-1)).toEqual({
      type: "exportResult",
      success: false,
      error: "disk full",
    });
    expect(h.logError).toHaveBeenCalled();
  });
});

describe("createPreviewController state and unknown messages", () => {
  it("exposes the last graph through getState", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    expect(controller.getState().graph).toBeUndefined();
    await controller.render();
    expect(controller.getState()).toMatchObject({ expanded: [], direction: "LR" });
    expect(controller.getState().graph?.cards).toHaveLength(3);
  });

  it("logs an unknown message type without throwing", async () => {
    const h = harness();
    const controller = createPreviewController(h.deps);
    await controller.handleMessage({ type: "nonsense" });
    expect(h.logError).toHaveBeenCalledWith("Unknown message from webview", { type: "nonsense" });
  });
});
