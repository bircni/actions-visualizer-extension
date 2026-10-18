/**
 * Assigns coordinates to a {@link GraphModel} using dagre, then routes the edges
 * as orthogonal elbows between connection dots on the card edges — the shape
 * GitHub uses.
 *
 * Layout runs in the extension host rather than the webview: it keeps the webview
 * a dumb SVG renderer, avoids a second bundle for browser code, and makes the whole
 * thing testable as plain Node code. Expanding a card changes its height, so the
 * host simply re-runs this and posts a fresh positioned graph.
 */

import { layout as dagreLayout } from "@dagrejs/dagre";
import { Graph } from "@dagrejs/graphlib";
import type { GraphCard, GraphEdge, GraphModel, GraphHeader } from "./graph.js";

type DagreGraphLabel = {
  rankdir: LayoutDirection;
  ranksep: number;
  nodesep: number;
  edgesep: number;
  marginx: number;
  marginy: number;
  acyclicer: "greedy";
};

type DagreNodeLabel = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

type DagreEdgeLabel = {
  /** Filled in by dagre: the polyline through any dummy nodes of a long edge. */
  points?: { x: number; y: number }[];
};

// oxlint-disable-next-line no-redeclare -- intentional type+value merge for the class-cast pattern below
type DagreGraph = {
  setGraph(label: DagreGraphLabel): DagreGraph;
  setDefaultEdgeLabel(factory: () => DagreEdgeLabel): DagreGraph;
  setNode(id: string, label: DagreNodeLabel): DagreGraph;
  setEdge(from: string, to: string, label: DagreEdgeLabel, name: string): DagreGraph;
  node(id: string): DagreNodeLabel;
  edge(from: string, to: string, name: string): DagreEdgeLabel | undefined;
};

// Dagre 3.1.1's declarations compile with TypeScript 7, but Oxlint cannot follow
// their Graphlib re-export yet. Keep that compatibility cast at the package boundary.
const DagreGraph = Graph as unknown as new (options: {
  multigraph: boolean;
  compound: boolean;
}) => DagreGraph;
const layoutDagreGraph = dagreLayout as unknown as (graph: DagreGraph) => void;

export type LayoutDirection = "LR" | "TB";

export type LayoutOptions = {
  direction: LayoutDirection;
  /** Row ids expanded to show their steps. */
  expandedRows: string[];
};

/**
 * Geometry constants. The webview draws from these rather than measuring text, and
 * receives them with every graph (see {@link PositionedGraph.metrics}) so the two
 * can never drift apart.
 */
export const METRICS = {
  cardWidth: 280,
  /** Vertical padding inside a card, above the first row and below the last. */
  cardPaddingY: 4,
  rowHeight: 36,
  /** Extra height for the `if:` line shown under an expanded row. */
  conditionHeight: 22,
  stepHeight: 24,
  /** Room left under the last step of an expanded row. */
  stepsPaddingBottom: 6,
  /** Height of the tab drawn above a matrix card. */
  tabHeight: 24,
  rankSeparation: 80,
  cardSeparation: 24,
  edgeSeparation: 16,
  margin: 32,
  /** Radius of the connection dots at each end of an edge. */
  dotRadius: 3.5,
  /** Corner radius of the elbow. */
  elbowRadius: 8,
  /** How far a backward edge, which only a `needs:` cycle produces, loops clear of the cards. */
  loopOffset: 20,
} as const;

/** The subset of {@link METRICS} the renderer needs to draw a card. */
type DrawingMetrics = Pick<
  typeof METRICS,
  | "rowHeight"
  | "conditionHeight"
  | "stepHeight"
  | "tabHeight"
  | "cardPaddingY"
  | "dotRadius"
  | "elbowRadius"
>;

const DRAWING_METRICS: DrawingMetrics = {
  rowHeight: METRICS.rowHeight,
  conditionHeight: METRICS.conditionHeight,
  stepHeight: METRICS.stepHeight,
  tabHeight: METRICS.tabHeight,
  cardPaddingY: METRICS.cardPaddingY,
  dotRadius: METRICS.dotRadius,
  elbowRadius: METRICS.elbowRadius,
};

type Point = { x: number; y: number };

type PositionedRow = GraphCard["rows"][number] & {
  /** Row offset from the top of its card. */
  offsetY: number;
  height: number;
  expanded: boolean;
  expandable: boolean;
};

type PositionedCard = Omit<GraphCard, "rows"> & {
  rows: PositionedRow[];
  /** Top-left corner of the card body, excluding any tab above it. */
  x: number;
  y: number;
  width: number;
  height: number;
};

type PositionedEdge = GraphEdge & {
  /** Orthogonal polyline from dot to dot, in graph coordinates. */
  points: Point[];
  /** Connection dot on the source card. */
  from_point: Point;
  /** Connection dot on the target card. */
  to_point: Point;
};

export type PositionedGraph = {
  header: GraphHeader;
  cards: PositionedCard[];
  edges: PositionedEdge[];
  warnings: string[];
  error?: string;
  width: number;
  height: number;
  direction: LayoutDirection;
  /** The geometry the cards were measured with, so the renderer draws to match. */
  metrics: DrawingMetrics;
};

/** Height of a single row, including its `if:` line and any expanded steps. */
function measureRow(
  row: GraphCard["rows"][number],
  expanded: boolean,
): { height: number; expandable: boolean } {
  const expandable = row.steps.length > 0 || row.condition != null;
  let height = METRICS.rowHeight;
  if (expanded) {
    if (row.condition != null) {
      height += METRICS.conditionHeight;
    }
    height += row.steps.length * METRICS.stepHeight + METRICS.stepsPaddingBottom;
  }
  return { height, expandable };
}

/** Lays a card's rows out vertically and returns the card's total size. */
function measureCard(
  card: GraphCard,
  expandedRows: Set<string>,
): { rows: PositionedRow[]; width: number; height: number } {
  const rows: PositionedRow[] = [];
  let offsetY = METRICS.cardPaddingY;
  for (const row of card.rows) {
    const expanded = expandedRows.has(row.id);
    const { height, expandable } = measureRow(row, expanded);
    rows.push({ ...row, offsetY, height, expanded: expanded && expandable, expandable });
    offsetY += height;
  }
  return {
    rows,
    width: METRICS.cardWidth,
    height: Math.max(offsetY + METRICS.cardPaddingY, METRICS.rowHeight + METRICS.cardPaddingY * 2),
  };
}

/** Reads and writes a point along the rank axis and across it, for either direction. */
type Axes = {
  /** Coordinate along the direction of flow. */
  main: (point: Point) => number;
  /** Coordinate across it. */
  cross: (point: Point) => number;
  point: (main: number, cross: number) => Point;
};

function axesFor(direction: LayoutDirection): Axes {
  return direction === "LR"
    ? { main: (p) => p.x, cross: (p) => p.y, point: (main, cross) => ({ x: main, y: cross }) }
    : { main: (p) => p.y, cross: (p) => p.x, point: (main, cross) => ({ x: cross, y: main }) };
}

/** Drops points that do not turn, so a straight run is a single segment. */
function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) {
      continue;
    }
    const beforeLast = result.at(-2);
    if (
      last &&
      beforeLast &&
      ((Math.abs(beforeLast.x - last.x) < 0.5 && Math.abs(last.x - point.x) < 0.5) ||
        (Math.abs(beforeLast.y - last.y) < 0.5 && Math.abs(last.y - point.y) < 0.5))
    ) {
      result[result.length - 1] = point;
      continue;
    }
    result.push(point);
  }
  return result;
}

/**
 * Routes an edge orthogonally between two connection dots.
 *
 * An edge that skips ranks must not cut through the cards in between. dagre has
 * already found it a free lane in every intermediate rank — the dummy nodes it
 * inserts for long edges — so the route runs along those lanes and only turns in
 * the gaps between ranks, where no card can be.
 *
 * @param lanes - dagre's dummy-node points inside intermediate ranks, in order.
 * @param rankExtent - Half the depth of a rank along the flow, by rank centre.
 */
function routeEdge(
  from: Point,
  to: Point,
  lanes: Point[],
  rankExtent: (center: number) => number,
  axes: Axes,
): Point[] {
  const waypoints = [from, ...lanes, to];
  const route: Point[] = [from];
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    const current = waypoints[index];
    const next = waypoints[index + 1];
    if (current == null || next == null) {
      continue;
    }
    const leaving =
      index === 0 ? axes.main(current) : axes.main(current) + rankExtent(axes.main(current));
    const arriving =
      index === waypoints.length - 2
        ? axes.main(next)
        : axes.main(next) - rankExtent(axes.main(next));
    const gap = (leaving + arriving) / 2;
    route.push(
      axes.point(leaving, axes.cross(current)),
      axes.point(gap, axes.cross(current)),
      axes.point(gap, axes.cross(next)),
      axes.point(arriving, axes.cross(next)),
    );
  }
  route.push(to);
  return simplify(route);
}

/**
 * Routes a backward edge, which only a `needs:` cycle produces, around the
 * outside of the graph rather than straight back through it.
 */
function routeBackEdge(from: Point, to: Point, outside: number, axes: Axes): Point[] {
  const out = axes.main(from) + METRICS.loopOffset;
  const back = axes.main(to) - METRICS.loopOffset;
  return simplify([
    from,
    axes.point(out, axes.cross(from)),
    axes.point(out, outside),
    axes.point(back, outside),
    axes.point(back, axes.cross(to)),
    to,
  ]);
}

/** Runs dagre over the cards and returns a plain, serialisable positioned graph. */
export function layoutGraph(model: GraphModel, options: LayoutOptions): PositionedGraph {
  const expandedRows = new Set(options.expandedRows);
  const base: PositionedGraph = {
    header: model.header,
    cards: [],
    edges: [],
    warnings: model.warnings,
    ...(model.error == null ? {} : { error: model.error }),
    width: 0,
    height: 0,
    direction: options.direction,
    metrics: DRAWING_METRICS,
  };

  if (model.cards.length === 0) {
    return base;
  }

  // dagre's Graph defaults every label to `any`; naming the label types keeps the
  // results type-safe on the way back out.
  const graph = new DagreGraph({ multigraph: true, compound: false });
  graph.setGraph({
    rankdir: options.direction,
    ranksep: METRICS.rankSeparation,
    nodesep: METRICS.cardSeparation,
    edgesep: METRICS.edgeSeparation,
    marginx: METRICS.margin,
    marginy: METRICS.margin,
    // `greedy` reverses the minimum number of edges needed to break cycles, so a
    // workflow with a circular `needs:` still lays out instead of throwing.
    acyclicer: "greedy",
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const measured = new Map<string, ReturnType<typeof measureCard>>();
  for (const card of model.cards) {
    const size = measureCard(card, expandedRows);
    measured.set(card.id, size);
    // A matrix card's tab sits above the body, so reserve room for it in layout.
    const reservedHeight = size.height + (card.tab == null ? 0 : METRICS.tabHeight);
    graph.setNode(card.id, { width: size.width, height: reservedHeight });
  }

  const edgeNames = new Map<GraphEdge, string>();
  model.edges.forEach((edge, index) => {
    if (measured.has(edge.from) && measured.has(edge.to)) {
      const name = `e${String(index)}`;
      edgeNames.set(edge, name);
      graph.setEdge(edge.from, edge.to, {}, name);
    }
  });

  layoutDagreGraph(graph);

  const cards: PositionedCard[] = model.cards.map((card) => {
    const size = measured.get(card.id) ?? measureCard(card, expandedRows);
    const laidOut = graph.node(card.id);
    const reservedHeight = size.height + (card.tab == null ? 0 : METRICS.tabHeight);
    // dagre positions nodes by their centre; the renderer draws from the top-left.
    const centerX = laidOut.x ?? size.width / 2;
    const centerY = laidOut.y ?? reservedHeight / 2;
    return {
      ...card,
      rows: size.rows,
      x: centerX - size.width / 2,
      // Offset past the tab so `y` is the top of the card body.
      y: centerY - reservedHeight / 2 + (card.tab == null ? 0 : METRICS.tabHeight),
      width: size.width,
      height: size.height,
    };
  });

  const cardsById = new Map(cards.map((card) => [card.id, card]));

  /**
   * Connection dots sit on the first row of the card, matching GitHub, so an edge
   * between two multi-row cards still reads as one connection.
   */
  const anchor = (card: PositionedCard, side: "from" | "to"): Point => {
    const firstRow = card.rows[0];
    const rowCenterY =
      card.y + (firstRow ? firstRow.offsetY + METRICS.rowHeight / 2 : card.height / 2);
    if (options.direction === "LR") {
      return { x: side === "from" ? card.x + card.width : card.x, y: rowCenterY };
    }
    return {
      x: card.x + card.width / 2,
      y: side === "from" ? card.y + card.height : card.y,
    };
  };

  const axes = axesFor(options.direction);

  // Every card in a rank shares its centre along the flow, so a rank is known by
  // that centre; its extent is half its deepest card, tab included.
  const rankExtents = new Map<number, number>();
  for (const card of cards) {
    const tab = card.tab == null ? 0 : METRICS.tabHeight;
    const depth = options.direction === "LR" ? card.width : card.height + tab;
    const center = options.direction === "LR" ? card.x + card.width / 2 : card.y - tab + depth / 2;
    const key = Math.round(center);
    rankExtents.set(key, Math.max(rankExtents.get(key) ?? 0, depth / 2));
  }
  const rankExtent = (center: number): number => rankExtents.get(Math.round(center)) ?? 0;

  const contentWidth = Math.max(...cards.map((card) => card.x + card.width), 0);
  const contentHeight = Math.max(...cards.map((card) => card.y + card.height), 0);
  const outside = (options.direction === "LR" ? contentHeight : contentWidth) + METRICS.loopOffset;
  let usesOutside = false;

  const edges: PositionedEdge[] = [];
  for (const edge of model.edges) {
    const fromCard = cardsById.get(edge.from);
    const toCard = cardsById.get(edge.to);
    if (!fromCard || !toCard) {
      continue;
    }
    const from = anchor(fromCard, "from");
    const to = anchor(toCard, "to");

    let points: Point[];
    if (axes.main(to) <= axes.main(from)) {
      usesOutside = true;
      points = routeBackEdge(from, to, outside, axes);
    } else {
      const name = edgeNames.get(edge);
      const dagrePoints = name == null ? [] : (graph.edge(edge.from, edge.to, name)?.points ?? []);
      // Keep only the dummy nodes that sit in a rank; the ones dagre places in the
      // gaps between ranks add nothing, since the route turns there anyway.
      const lanes = dagrePoints.filter((point) => {
        const main = axes.main(point);
        return main > axes.main(from) && main < axes.main(to) && rankExtents.has(Math.round(main));
      });
      points = routeEdge(from, to, lanes, rankExtent, axes);
    }
    edges.push({ ...edge, from_point: from, to_point: to, points });
  }

  const loopRoom = usesOutside ? METRICS.loopOffset : 0;
  return {
    ...base,
    cards,
    edges,
    width: contentWidth + METRICS.margin + (options.direction === "TB" ? loopRoom : 0),
    height: contentHeight + METRICS.margin + (options.direction === "LR" ? loopRoom : 0),
  };
}
