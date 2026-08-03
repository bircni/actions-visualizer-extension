import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, type BuildGraphOptions, type GraphModel } from "../workflow/graph.js";
import { METRICS, layoutGraph, type PositionedGraph } from "../workflow/layout.js";
import { parseWorkflow } from "../workflow/parse.js";

const FIXTURE_DIR = path.join(process.cwd(), ".fixtures", "workflows");

const DEFAULTS: BuildGraphOptions = {
  fileName: "ci.yml",
  showSteps: true,
  expandMatrix: false,
  simulation: { inputs: {} },
  expanded: [],
};

function graphOf(name: string, options?: Partial<BuildGraphOptions>): GraphModel {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
  return buildGraph(parseWorkflow(text), { ...DEFAULTS, ...options });
}

function laidOut(name: string, options?: Partial<BuildGraphOptions>): PositionedGraph {
  return layoutGraph(graphOf(name, options), { direction: "LR", expandedRows: [] });
}

function card(graph: PositionedGraph, id: string): PositionedGraph["cards"][number] | undefined {
  return graph.cards.find((candidate) => candidate.id === id);
}

describe("card measurement", () => {
  it("grows a card by one row height per job", () => {
    const graph = laidOut("fan-out.yml");
    const single = card(graph, "card:group:0:");
    const double = card(graph, "card:group:1:build");
    expect((double?.height ?? 0) - (single?.height ?? 0)).toBe(METRICS.rowHeight);
  });

  it("stacks rows without overlapping", () => {
    const rows = card(laidOut("fan-out.yml"), "card:group:1:build")?.rows ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.offsetY).toBe((rows[0]?.offsetY ?? 0) + (rows[0]?.height ?? 0));
  });

  it("keeps every row inside its card", () => {
    for (const entry of laidOut("fan-out.yml").cards) {
      for (const row of entry.rows) {
        expect(row.offsetY).toBeGreaterThanOrEqual(0);
        expect(row.offsetY + row.height).toBeLessThanOrEqual(entry.height);
      }
    }
  });

  it("grows a row when it is expanded to show its steps", () => {
    const graph = graphOf("simple.yml");
    const collapsed = layoutGraph(graph, { direction: "LR", expandedRows: [] });
    const expanded = layoutGraph(graph, { direction: "LR", expandedRows: ["row:build"] });
    const before = collapsed.cards[0]?.rows[0];
    const after = expanded.cards[0]?.rows[0];
    expect(after?.height ?? 0).toBeGreaterThan(before?.height ?? 0);
    expect(after?.expanded).toBe(true);
    expect(collapsed.cards[0]?.height ?? 0).toBeLessThan(expanded.cards[0]?.height ?? 0);
  });

  it("marks a row expandable only when it has steps or a condition", () => {
    const withSteps = laidOut("simple.yml").cards[0]?.rows[0];
    expect(withSteps?.expandable).toBe(true);
    const missing = laidOut("missing-needs.yml").cards.find((entry) => entry.kind === "missing");
    expect(missing?.rows[0]?.expandable).toBe(false);
  });

  it("reserves room above a matrix card for its tab", () => {
    const graph = laidOut("matrix.yml");
    // The tab is drawn above `y`, so the card body must clear it.
    expect(graph.cards[0]?.y ?? 0).toBeGreaterThanOrEqual(METRICS.tabHeight);
  });
});

describe("layoutGraph placement", () => {
  it("positions every card and routes every edge", () => {
    const graph = laidOut("fan-out.yml");
    expect(graph.cards).toHaveLength(3);
    expect(graph.cards.every((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y))).toBe(
      true,
    );
    expect(graph.edges.every((edge) => edge.points.length >= 2)).toBe(true);
    expect(graph.width).toBeGreaterThan(0);
    expect(graph.height).toBeGreaterThan(0);
  });

  it("is deterministic for the same input", () => {
    const graph = graphOf("fan-out.yml");
    const first = layoutGraph(graph, { direction: "LR", expandedRows: [] });
    const second = layoutGraph(graph, { direction: "LR", expandedRows: [] });
    expect(second.cards).toEqual(first.cards);
    expect(second.edges).toEqual(first.edges);
  });

  it("orders cards left to right by dependency depth", () => {
    const graph = laidOut("fan-out.yml");
    const x = (id: string): number => card(graph, id)?.x ?? Number.NaN;
    expect(x("card:group:0:")).toBeLessThan(x("card:group:1:build"));
    expect(x("card:group:1:build")).toBeLessThan(x("card:group:2:lint,test"));
  });

  it("flows top to bottom when asked", () => {
    const graph = layoutGraph(graphOf("fan-out.yml"), { direction: "TB", expandedRows: [] });
    const y = (id: string): number => graph.cards.find((c) => c.id === id)?.y ?? Number.NaN;
    expect(y("card:group:0:")).toBeLessThan(y("card:group:2:lint,test"));
    expect(graph.direction).toBe("TB");
  });

  it("never overlaps two cards", () => {
    const graph = laidOut("fan-out.yml");
    for (let i = 0; i < graph.cards.length; i += 1) {
      for (let j = i + 1; j < graph.cards.length; j += 1) {
        const a = graph.cards[i];
        const b = graph.cards[j];
        if (!a || !b) {
          continue;
        }
        const separated =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(separated).toBe(true);
      }
    }
  });

  it("keeps the canvas large enough to contain every card", () => {
    const graph = layoutGraph(graphOf("fan-out.yml"), {
      direction: "LR",
      expandedRows: ["row:build", "row:test"],
    });
    for (const entry of graph.cards) {
      expect(entry.x + entry.width).toBeLessThanOrEqual(graph.width);
      expect(entry.y + entry.height).toBeLessThanOrEqual(graph.height);
    }
  });

  it("lays out a cyclic graph instead of throwing", () => {
    const graph = laidOut("cycle.yml");
    expect(graph.cards.length).toBeGreaterThan(0);
    expect(graph.edges.every((edge) => edge.points.length >= 2)).toBe(true);
  });

  it("returns an empty canvas for an errored graph, keeping the header", () => {
    const graph = laidOut("broken.yml");
    expect(graph.cards).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.width).toBe(0);
    expect(graph.error).toBeTruthy();
    expect(graph.header.fileName).toBe("ci.yml");
  });
});

describe("edge routing", () => {
  it("anchors edges to the card edges, on the first row", () => {
    const graph = laidOut("fan-out.yml");
    const edge = graph.edges[0];
    const from = card(graph, "card:group:0:");
    const to = card(graph, "card:group:1:build");
    expect(edge?.from_point.x).toBe((from?.x ?? 0) + (from?.width ?? 0));
    expect(edge?.to_point.x).toBe(to?.x);
    // Vertically centred on the first row, the way GitHub draws it.
    const firstRow = from?.rows[0];
    expect(edge?.from_point.y).toBe(
      (from?.y ?? 0) + (firstRow?.offsetY ?? 0) + METRICS.rowHeight / 2,
    );
  });

  it("routes an elbow with a single mid-track when the cards are offset", () => {
    const graph = laidOut("fan-out.yml");
    const elbow = graph.edges.find((edge) => edge.points.length > 2);
    expect(elbow).toBeDefined();
    expect(elbow?.points).toHaveLength(4);
    // The two middle points share an x, making the vertical segment of the elbow.
    expect(elbow?.points[1]?.x).toBe(elbow?.points[2]?.x);
  });

  it("draws a straight line when the two cards line up", () => {
    const graph = layoutGraph(
      buildGraph(parseWorkflow("on: push\njobs:\n  a:\n  b:\n    needs: a\n"), DEFAULTS),
      { direction: "LR", expandedRows: [] },
    );
    expect(graph.edges[0]?.points).toHaveLength(2);
  });

  it("anchors vertically when the graph flows top to bottom", () => {
    const graph = layoutGraph(graphOf("fan-out.yml"), { direction: "TB", expandedRows: [] });
    const edge = graph.edges[0];
    const from = graph.cards.find((entry) => entry.id === "card:group:0:");
    expect(edge?.from_point.y).toBe((from?.y ?? 0) + (from?.height ?? 0));
    expect(edge?.from_point.x).toBe((from?.x ?? 0) + (from?.width ?? 0) / 2);
  });
});
