/**
 * The preview's behaviour, with every VS Code API call injected as a lambda.
 *
 * Keeping the controller free of `import * as vscode` is what makes the whole
 * render pipeline unit-testable: tests hand it a fake `PreviewDeps` and assert on
 * the messages it posts, with no extension host in sight.
 */

import type { LayoutDirection, PositionedGraph } from "../workflow/layout.js";
import { parseWorkflow } from "../workflow/parse.js";
import { buildGraphMessage, type SimulationView } from "./graphMessage.js";
import {
  defaultInputValue,
  inputsFor,
  refChoicesFor,
  type Simulation,
} from "../workflow/simulate.js";
import type { WorkflowInput, WorkflowModel } from "../workflow/model.js";
import type { PreviewSettings } from "./previewConfig.js";

/** Messages the webview sends to the host. */
export type WebviewHostMessage = {
  type: string;
  /** Card or row id for `toggleExpand`. */
  nodeId?: string;
  /** Byte offset into the workflow source for `revealSource`. */
  offset?: number;
  /** Requested layout direction for `setDirection`. */
  direction?: string;
  /** Event name for `setEvent`, or ref for `setRef`. */
  value?: string;
  /** Input name for `setInput`, or context path for `setPin`. */
  name?: string;
  /** Input value for `setInput`. */
  input?: string | boolean | number;
  /** Serialised SVG for `exportSvg`. */
  svg?: string;
};

/** Messages the host sends to the webview. */
export type HostWebviewMessage =
  | {
      type: "graph";
      graph: PositionedGraph;
      expanded: string[];
      simulation: SimulationView;
    }
  | { type: "requestExport" }
  | { type: "exportResult"; success: boolean; path?: string; error?: string };

export type PreviewDeps = {
  /** Current text of the previewed workflow file. */
  readText: () => string;
  /** File-system path of the previewed workflow file, used for titles and logging. */
  readPath: () => string;
  /** Current settings, re-read on every render so changes take effect immediately. */
  readSettings: () => PreviewSettings;
  postMessage: (message: HostWebviewMessage) => Thenable<boolean> | boolean;
  /** Moves the editor selection to the given source offset. */
  revealSource: (offset: number) => void | Promise<void>;
  /** Prompts for a target path and writes the SVG; resolves to the written path. */
  saveSvg: (svg: string, defaultName: string) => Promise<string | undefined>;
  logInfo: (message: string, data?: Record<string, unknown>) => void;
  logError: (message: string, error?: unknown) => void;
};

/** Everything a test needs to assert on, and what the host e2e bridge exposes. */
export type PreviewState = {
  graph?: PositionedGraph;
  expanded: string[];
  direction: LayoutDirection;
  simulation: Simulation;
};

export type PreviewController = {
  /** Parses, lays out and posts the current document. */
  render: () => Promise<void>;
  handleMessage: (message: WebviewHostMessage) => Promise<void>;
  /** Asks the webview to serialise its SVG and send it back for saving. */
  requestExport: () => Promise<void>;
  getState: () => PreviewState;
};

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? "workflow.yml";
}

export function createPreviewController(deps: PreviewDeps): PreviewController {
  const expanded = new Set<string>();
  let directionOverride: LayoutDirection | undefined;
  let lastGraph: PositionedGraph | undefined;
  let simulation: Simulation = { inputs: {} };
  /** Cleared once, so the first render can pick a sensible default event. */
  let simulationInitialized = false;
  let expandedInitialized = false;

  const currentDirection = (settings: PreviewSettings): LayoutDirection =>
    directionOverride ?? settings.direction;

  /**
   * Picks the event to simulate when the user has not chosen one, and keeps the
   * ref valid for whichever event is selected.
   */
  const reconcileSimulation = (model: WorkflowModel): void => {
    const events = model.triggers.map((trigger) => trigger.event);
    if (!simulationInitialized && events.length > 0) {
      simulationInitialized = true;
      simulation = { ...simulation, event: events[0] };
    }
    // A renamed or removed trigger must not leave a stale selection behind.
    if (simulation.event != null && !events.includes(simulation.event)) {
      simulation = { ...simulation, event: events[0], ref: undefined, inputs: {} };
    }

    // Only fill in a default; a ref the user typed is kept even when it matches
    // no filter, because seeing the workflow *not* fire is the point.
    if (simulation.ref == null) {
      const trigger = model.triggers.find((candidate) => candidate.event === simulation.event);
      simulation = { ...simulation, ref: refChoicesFor(trigger)[0]?.ref };
    }

    // Drop values for inputs the selected event does not declare.
    const declared = new Set(inputsFor(model, simulation.event).map((input) => input.name));
    const values: Record<string, string | boolean | number> = {};
    for (const [name, value] of Object.entries(simulation.inputs)) {
      if (declared.has(name)) {
        values[name] = value;
      }
    }
    simulation = { ...simulation, inputs: values };
  };

  const render = async (): Promise<void> => {
    const settings = deps.readSettings();
    const model = parseWorkflow(deps.readText());
    reconcileSimulation(model);

    // The `showSteps: expanded` setting seeds the expansion once; after that the
    // user owns it. The builder resolves which rows those are, since it is the
    // only place that knows how row ids are spelt.
    const seedAll = !expandedInitialized && settings.showSteps === "expanded";
    expandedInitialized = true;

    const { body, liveExpanded } = buildGraphMessage(model, {
      fileName: fileNameOf(deps.readPath()),
      showSteps: settings.showSteps !== "never",
      expandMatrix: settings.expandMatrix,
      direction: currentDirection(settings),
      simulation,
      expanded: [...expanded],
      ...(seedAll ? { expandAllRows: true } : {}),
    });

    // Adopt what survived, so a renamed job cannot keep the graph expanded on a
    // row that no longer exists.
    expanded.clear();
    for (const id of liveExpanded) {
      expanded.add(id);
    }

    lastGraph = body.graph;
    await deps.postMessage({ type: "graph", ...body });
  };

  const toggleExpand = async (nodeId: string | undefined): Promise<void> => {
    if (nodeId == null) {
      return;
    }
    if (expanded.has(nodeId)) {
      expanded.delete(nodeId);
    } else {
      expanded.add(nodeId);
    }
    await render();
  };

  const setAllExpanded = async (value: boolean): Promise<void> => {
    if (!value) {
      expanded.clear();
    } else if (lastGraph) {
      for (const card of lastGraph.cards) {
        if (card.expandable) {
          expanded.add(card.id);
        }
        for (const row of card.rows) {
          if (row.expandable) {
            expanded.add(row.id);
          }
        }
      }
    }
    await render();
  };

  const setInput = async (name: string | undefined, value: unknown): Promise<void> => {
    if (name == null) {
      return;
    }
    const model = parseWorkflow(deps.readText());
    const declared = inputsFor(model, simulation.event).find((input) => input.name === name);
    if (!declared) {
      return;
    }
    simulation = {
      ...simulation,
      inputs: { ...simulation.inputs, [name]: coerceInput(declared, value) },
    };
    await render();
  };

  /**
   * Pins a value for a context path the simulation cannot resolve. An empty value
   * is a meaningful pin — `secrets.X == ''` is a real condition — so a pin is only
   * removed when the webview sends no value at all.
   */
  const setPin = async (
    path: string | undefined,
    value: string | boolean | number | undefined,
  ): Promise<void> => {
    if (path == null || path.length === 0) {
      return;
    }
    const pinned = { ...simulation.pinned };
    if (value == null) {
      delete pinned[path];
    } else {
      pinned[path] = String(value);
    }
    simulation = { ...simulation, pinned };
    await render();
  };

  const exportSvg = async (svg: string | undefined): Promise<void> => {
    if (svg == null || svg.length === 0) {
      await deps.postMessage({
        type: "exportResult",
        success: false,
        error: "The graph is empty, so there is nothing to export.",
      });
      return;
    }
    const base = fileNameOf(deps.readPath());
    const defaultName = `${base.replace(/\.ya?ml$/i, "")}.svg`;
    try {
      const written = await deps.saveSvg(svg, defaultName);
      if (written == null) {
        // The user dismissed the save dialog; not an error worth reporting.
        return;
      }
      deps.logInfo("Exported workflow graph", { path: written });
      await deps.postMessage({ type: "exportResult", success: true, path: written });
    } catch (error) {
      deps.logError("Failed to export workflow graph", error);
      await deps.postMessage({
        type: "exportResult",
        success: false,
        error: error instanceof Error ? error.message : "Could not write the SVG file.",
      });
    }
  };

  const handleMessage = async (message: WebviewHostMessage): Promise<void> => {
    switch (message.type) {
      case "ready":
      case "refresh":
        await render();
        return;
      case "toggleExpand":
        await toggleExpand(message.nodeId);
        return;
      case "expandAll":
        await setAllExpanded(true);
        return;
      case "collapseAll":
        await setAllExpanded(false);
        return;
      case "setDirection":
        directionOverride = message.direction === "TB" ? "TB" : "LR";
        await render();
        return;
      case "setEvent":
        // Changing the event invalidates the ref and the input values with it.
        simulationInitialized = true;
        simulation = { event: message.value ?? undefined, inputs: {}, pinned: {} };
        await render();
        return;
      case "setRef":
        simulation = { ...simulation, ref: message.value ?? undefined };
        await render();
        return;
      case "setInput":
        await setInput(message.name, message.input);
        return;
      case "setPin":
        await setPin(message.name, message.input);
        return;
      case "revealSource":
        if (typeof message.offset === "number" && message.offset >= 0) {
          await deps.revealSource(message.offset);
        }
        return;
      case "exportSvg":
        await exportSvg(message.svg);
        return;
      default:
        deps.logError("Unknown message from webview", { type: message.type });
    }
  };

  return {
    render,
    handleMessage,
    requestExport: async () => {
      await deps.postMessage({ type: "requestExport" });
    },
    getState: () => ({
      ...(lastGraph == null ? {} : { graph: lastGraph }),
      expanded: [...expanded],
      direction: currentDirection(deps.readSettings()),
      simulation,
    }),
  };
}

/** Coerces a value from the webview form to the input's declared type. */
function coerceInput(input: WorkflowInput, value: unknown): string | boolean | number {
  if (input.type === "boolean") {
    return value === true || value === "true";
  }
  if (input.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return defaultInputValue(input);
}
