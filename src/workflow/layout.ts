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

import {
  Graph,
  layout as dagreLayout,
  type EdgeLabel,
  type GraphLabel,
  type NodeLabel,
} from "@dagrejs/dagre";
import type { GraphCard, GraphEdge, GraphModel, GraphHeader } from "./graph.js";

export type LayoutDirection = "LR" | "TB";

export type LayoutOptions = {
  direction: LayoutDirection;
  /** Row ids expanded to show their steps. */
  expandedRows: string[];
};

/**
 * Geometry constants. These must stay in sync with the webview stylesheet, which is
 * why the webview receives every box's width and height rather than measuring text.
 */
export const METRICS = {
  cardWidth: 300,
  /** Vertical padding inside a card, above the first row and below the last. */
  cardPaddingY: 12,
  rowHeight: 34,
  /** Extra height for the `if:` line shown under an expanded row. */
  conditionHeight: 18,
  stepHeight: 20,
  /** Height of the tab drawn above a matrix card. */
  tabHeight: 26,
  rankSeparation: 96,
  cardSeparation: 28,
  edgeSeparation: 16,
  margin: 24,
  /** Radius of the connection dots at each end of an edge. */
  dotRadius: 5,
  /** How far the elbow stands off from the card before turning. */
  elbowOffset: 22,
  /** Corner radius of the elbow. */
  elbowRadius: 10,
} as const;

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
  /** Polyline through the elbow, in graph coordinates. */
  points: { x: number; y: number }[];
  /** Connection dot on the source card. */
  from_point: { x: number; y: number };
  /** Connection dot on the target card. */
  to_point: { x: number; y: number };
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
    height += row.steps.length * METRICS.stepHeight;
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

/**
 * Builds the rounded elbow between two connection dots.
 *
 * The path leaves the source horizontally (or vertically, in `TB`), turns once
 * toward the target's track, then turns again to arrive head-on.
 */
function elbowPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  direction: LayoutDirection,
): { x: number; y: number }[] {
  if (direction === "LR") {
    const midX = (from.x + to.x) / 2;
    if (Math.abs(from.y - to.y) < 1) {
      return [from, to];
    }
    return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
  }
  const midY = (from.y + to.y) / 2;
  if (Math.abs(from.x - to.x) < 1) {
    return [from, to];
  }
  return [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to];
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
  };

  if (model.cards.length === 0) {
    return base;
  }

  // dagre's Graph defaults every label to `any`; naming the label types keeps the
  // results type-safe on the way back out.
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true, compound: false });
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

  model.edges.forEach((edge, index) => {
    if (measured.has(edge.from) && measured.has(edge.to)) {
      graph.setEdge(edge.from, edge.to, {}, `e${String(index)}`);
    }
  });

  dagreLayout(graph);

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
  const anchor = (card: PositionedCard, side: "from" | "to"): { x: number; y: number } => {
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

  const edges: PositionedEdge[] = [];
  for (const edge of model.edges) {
    const fromCard = cardsById.get(edge.from);
    const toCard = cardsById.get(edge.to);
    if (!fromCard || !toCard) {
      continue;
    }
    const from = anchor(fromCard, "from");
    const to = anchor(toCard, "to");
    edges.push({
      ...edge,
      from_point: from,
      to_point: to,
      points: elbowPoints(from, to, options.direction),
    });
  }

  const contentWidth = Math.max(...cards.map((card) => card.x + card.width), 0);
  const contentHeight = Math.max(...cards.map((card) => card.y + card.height), 0);

  return {
    ...base,
    cards,
    edges,
    width: contentWidth + METRICS.margin,
    height: contentHeight + METRICS.margin,
  };
}
