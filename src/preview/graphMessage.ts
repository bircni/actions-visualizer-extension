/**
 * Assembles the `graph` message the host posts to the webview.
 *
 * This exists because the assembly was written out three times — in the
 * controller, in the JSDOM harness and in the browser-fixture script — so a new
 * field on the message meant editing three places, and forgetting one left the
 * tests quietly exercising a shape the extension no longer posts.
 *
 * Pure: no `vscode`, no state. The controller owns which ids are expanded; this
 * module only reports which of them survived, so the caller can adopt the result.
 */

import { buildGraph } from "../workflow/graph.js";
import { layoutGraph, type LayoutDirection, type PositionedGraph } from "../workflow/layout.js";
import {
  inputsFor,
  refChoicesFor,
  unresolvedPaths,
  withInputDefaults,
  type RefChoice,
  type Simulation,
} from "../workflow/simulate.js";
import type { WorkflowInput, WorkflowModel } from "../workflow/model.js";

/** The simulation controls rendered in the header. */
export type SimulationView = {
  event?: string;
  ref?: string;
  refChoices: RefChoice[];
  inputs: WorkflowInput[];
  values: Record<string, string | boolean | number>;
  /**
   * Context paths the workflow's conditions depend on that the preview cannot
   * resolve, plus any the user has already pinned. Pinned paths stay listed so
   * the field does not vanish the moment it resolves.
   */
  pinnable: string[];
  pinned: Record<string, string>;
};

/** The body of the `graph` message, minus its `type`. */
export type GraphMessageBody = {
  graph: PositionedGraph;
  expanded: string[];
  simulation: SimulationView;
};

export type GraphMessageOptions = {
  fileName: string;
  showSteps: boolean;
  expandMatrix: boolean;
  direction: LayoutDirection;
  simulation: Simulation;
  /** Card and row ids the user has expanded. */
  expanded: string[];
  /**
   * Expand every row that has steps, whatever `expanded` says. Used once, when
   * the `showSteps: expanded` setting seeds the initial state, so the caller does
   * not have to know how row ids are spelt — matrix combinations included.
   */
  expandAllRows?: boolean;
};

export type GraphMessageResult = {
  body: GraphMessageBody;
  /**
   * The expanded ids that still exist. A renamed job would otherwise keep the
   * graph expanded on a row that is gone, so the caller adopts this.
   */
  liveExpanded: string[];
};

/** Projects the simulation state into the controls the header renders. */
function buildSimulationView(model: WorkflowModel, simulation: Simulation): SimulationView {
  const trigger = model.triggers.find((candidate) => candidate.event === simulation.event);
  const pinned = simulation.pinned ?? {};
  const pinnable = [
    ...new Set([...unresolvedPaths(model, simulation), ...Object.keys(pinned)]),
  ].toSorted();
  return {
    ...(simulation.event == null ? {} : { event: simulation.event }),
    ...(simulation.ref == null ? {} : { ref: simulation.ref }),
    refChoices: refChoicesFor(trigger),
    inputs: inputsFor(model, simulation.event),
    values: withInputDefaults(model, simulation),
    pinnable,
    pinned,
  };
}

/** Builds, prunes, lays out and projects — the whole host render path, once. */
export function buildGraphMessage(
  model: WorkflowModel,
  options: GraphMessageOptions,
): GraphMessageResult {
  const graph = buildGraph(model, {
    fileName: options.fileName,
    showSteps: options.showSteps,
    expandMatrix: options.expandMatrix,
    simulation: options.simulation,
    expanded: options.expanded,
  });

  const liveIds = new Set<string>();
  const rowsWithSteps: string[] = [];
  for (const card of graph.cards) {
    liveIds.add(card.id);
    for (const row of card.rows) {
      liveIds.add(row.id);
      if (row.steps.length > 0) {
        rowsWithSteps.push(row.id);
      }
    }
  }
  const liveExpanded =
    options.expandAllRows === true
      ? rowsWithSteps
      : options.expanded.filter((id) => liveIds.has(id));

  const positioned = layoutGraph(graph, {
    direction: options.direction,
    expandedRows: liveExpanded,
  });

  return {
    body: {
      graph: positioned,
      expanded: liveExpanded,
      simulation: buildSimulationView(model, options.simulation),
    },
    liveExpanded,
  };
}
