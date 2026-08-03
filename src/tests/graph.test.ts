import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_EXPANDED_MATRIX_ROWS,
  buildGraph,
  type BuildGraphOptions,
  type GraphModel,
} from "../workflow/graph.js";
import { parseWorkflow } from "../workflow/parse.js";

const FIXTURE_DIR = path.join(process.cwd(), ".fixtures", "workflows");

const DEFAULTS: BuildGraphOptions = {
  fileName: "ci.yml",
  showSteps: true,
  expandMatrix: false,
  simulation: { inputs: {} },
  expanded: [],
};

function graphOfText(text: string, options?: Partial<BuildGraphOptions>): GraphModel {
  return buildGraph(parseWorkflow(text), { ...DEFAULTS, ...options });
}

function graphOf(name: string, options?: Partial<BuildGraphOptions>): GraphModel {
  return graphOfText(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"), options);
}

/** Compact view of a graph: one entry per card, listing its row titles. */
function shape(graph: GraphModel): { id: string; kind: string; rows: string[] }[] {
  return graph.cards.map((card) => ({
    id: card.id,
    kind: card.kind,
    rows: card.rows.map((row) => row.title),
  }));
}

describe("buildGraph header", () => {
  it("uses the workflow name and lists its triggers", () => {
    const graph = graphOf("fan-out.yml");
    expect(graph.header.title).toBe("Fan Out");
    expect(graph.header.fileName).toBe("ci.yml");
    expect(graph.header.triggers.map((trigger) => trigger.event)).toEqual(["push", "pull_request"]);
  });

  it("falls back to the file name when the workflow has no name", () => {
    expect(graphOfText("on: push\njobs:\n  a:\n").header.title).toBe("ci.yml");
  });

  it("marks the simulated trigger as selected", () => {
    const graph = graphOf("fan-out.yml", { simulation: { event: "pull_request", inputs: {} } });
    expect(graph.header.triggers.filter((trigger) => trigger.selected)).toHaveLength(1);
    expect(graph.header.triggers[1]?.selected).toBe(true);
  });

  it("keeps a header even when the file does not parse", () => {
    const graph = graphOf("broken.yml");
    expect(graph.error).toBeTruthy();
    expect(graph.header.fileName).toBe("ci.yml");
    expect(graph.cards).toEqual([]);
  });
});

describe("buildGraph card grouping", () => {
  it("groups jobs at the same depth that share their dependencies", () => {
    // This is the grouping GitHub shows: build alone, then lint+test together.
    expect(shape(graphOf("fan-out.yml"))).toEqual([
      { id: "card:group:0:", kind: "jobs", rows: ["build"] },
      { id: "card:group:1:build", kind: "jobs", rows: ["lint", "test"] },
      { id: "card:group:2:lint,test", kind: "jobs", rows: ["publish"] },
    ]);
  });

  it("keeps jobs with different dependencies in separate cards", () => {
    const graph = graphOfText(
      ["on: push", "jobs:", "  a:", "  b:", "  c:", "    needs: a", "  d:", "    needs: b"].join(
        "\n",
      ),
    );
    // `c` and `d` are both at depth 1 but depend on different jobs.
    expect(shape(graph)).toEqual([
      { id: "card:group:0:", kind: "jobs", rows: ["a", "b"] },
      { id: "card:group:1:a", kind: "jobs", rows: ["c"] },
      { id: "card:group:1:b", kind: "jobs", rows: ["d"] },
    ]);
  });

  it("treats `needs:` order as irrelevant when grouping", () => {
    const graph = graphOfText(
      [
        "on: push",
        "jobs:",
        "  a:",
        "  b:",
        "  c:",
        "    needs: [a, b]",
        "  d:",
        "    needs: [b, a]",
      ].join("\n"),
    );
    expect(graph.cards).toHaveLength(2);
    expect(graph.cards[1]?.rows.map((row) => row.title)).toEqual(["c", "d"]);
  });

  it("shows the runner in the row's right-hand slot", () => {
    const row = graphOf("fan-out.yml").cards[0]?.rows[0];
    expect(row?.meta).toBe("ubuntu-latest");
  });

  it("labels a reusable workflow call instead of a runner", () => {
    const graph = graphOf("reusable.yml");
    const call = graph.cards.flatMap((card) => card.rows).find((row) => row.jobId === "call");
    expect(call?.meta).toBe("reusable workflow");
    expect(call?.uses).toBe("./.github/workflows/simple.yml");
  });

  it("carries steps only when steps are enabled", () => {
    expect(graphOf("simple.yml").cards[0]?.rows[0]?.steps).toEqual([
      { name: "actions/checkout@v5", kind: "uses", conditional: false, state: "run" },
      { name: "Build", kind: "run", conditional: false, state: "run" },
    ]);
    expect(graphOf("simple.yml", { showSteps: false }).cards[0]?.rows[0]?.steps).toEqual([]);
  });
});

describe("buildGraph matrix cards", () => {
  it("gives a matrix job its own tabbed card summarising the combinations", () => {
    const graph = graphOf("matrix.yml");
    expect(graph.cards).toEqual([
      expect.objectContaining({
        id: "card:matrix:test",
        kind: "matrix",
        tab: "Matrix: test",
        expandable: true,
        expanded: false,
      }),
    ]);
    expect(graph.cards[0]?.rows.map((row) => row.title)).toEqual(["4 jobs"]);
  });

  it("expands to one row per combination when the card is expanded", () => {
    const graph = graphOf("matrix.yml", { expanded: ["card:matrix:test"] });
    expect(graph.cards[0]?.rows.map((row) => row.title)).toEqual([
      "test (ubuntu-latest, 20)",
      "test (ubuntu-latest, 22)",
      "test (macos-latest, 20)",
      "test (macos-latest, 22)",
    ]);
  });

  it("expands every matrix when the setting says so", () => {
    expect(graphOf("matrix.yml", { expandMatrix: true }).cards[0]?.rows).toHaveLength(4);
  });

  it("caps expansion and says so instead of silently truncating", () => {
    const values = Array.from({ length: 12 }, (_, index) => `v${String(index)}`).join(", ");
    const graph = graphOfText(
      `on: push\njobs:\n  a:\n    strategy:\n      matrix:\n        x: [${values}]\n        y: [${values}]\n`,
      { expandMatrix: true },
    );
    expect(graph.cards[0]?.rows).toHaveLength(MAX_EXPANDED_MATRIX_ROWS);
    expect(graph.warnings.some((warning) => warning.includes("only the first"))).toBe(true);
  });

  it("leaves a dynamic matrix unexpandable", () => {
    const graph = graphOfText(
      "on: push\njobs:\n  a:\n    strategy:\n      matrix: ${{ fromJSON(needs.s.outputs.m) }}\n",
      { expandMatrix: true },
    );
    expect(graph.cards[0]?.expandable).toBe(false);
    expect(graph.cards[0]?.rows.map((row) => row.title)).toEqual(["a (matrix)"]);
  });
});

describe("buildGraph edges", () => {
  it("draws one edge per card pair rather than per job", () => {
    const graph = graphOf("fan-out.yml");
    // build -> {lint,test} and {lint,test} -> publish, deduplicated to two edges.
    expect(graph.edges).toEqual([
      { from: "card:group:0:", to: "card:group:1:build", inactive: false, broken: false },
      { from: "card:group:1:build", to: "card:group:2:lint,test", inactive: false, broken: false },
    ]);
  });

  it("never draws an edge from a card to itself", () => {
    const graph = graphOfText("on: push\njobs:\n  a:\n  b:\n    needs: a\n");
    expect(graph.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  it("fades an edge only when every job behind it is skipped", () => {
    const graph = graphOfText(
      [
        "on: push",
        "jobs:",
        "  a:",
        "  skipped:",
        "    needs: a",
        "    if: false",
        "  kept:",
        "    needs: a",
      ].join("\n"),
      { simulation: { event: "push", inputs: {} } },
    );
    // `skipped` and `kept` share a card, and `kept` still runs, so the edge stays lit.
    expect(graph.edges[0]?.inactive).toBe(false);

    const allSkipped = graphOfText("on: push\njobs:\n  a:\n  b:\n    needs: a\n    if: false\n", {
      simulation: { event: "push", inputs: {} },
    });
    expect(allSkipped.edges[0]?.inactive).toBe(true);
  });
});

describe("buildGraph problem reporting", () => {
  it("collects unresolved `needs:` targets into their own card", () => {
    const graph = graphOf("missing-needs.yml");
    const missing = graph.cards.find((card) => card.kind === "missing");
    expect(missing?.rows.map((row) => row.title)).toEqual(["nonexistent"]);
    expect(missing?.rows[0]?.meta).toBe("no such job");
    expect(graph.edges.some((edge) => edge.broken)).toBe(true);
    expect(graph.warnings).toContain(
      "Job `deploy` needs `nonexistent`, which is not defined in this workflow.",
    );
  });

  it("lists each missing job once", () => {
    const graph = graphOfText("on: push\njobs:\n  a:\n    needs: ghost\n  b:\n    needs: ghost\n");
    expect(graph.cards.find((card) => card.kind === "missing")?.rows).toHaveLength(1);
  });

  it("reports a `needs:` cycle without dropping the jobs", () => {
    const graph = graphOf("cycle.yml");
    expect(graph.cards.flatMap((card) => card.rows)).toHaveLength(3);
    expect(graph.warnings.some((warning) => warning.startsWith("Circular `needs:`"))).toBe(true);
  });

  it("reports an empty workflow as having nothing to draw", () => {
    expect(graphOfText("on: push\n").error).toBe("This workflow defines no jobs to visualize.");
  });

  it("surfaces parser diagnostics as warnings", () => {
    expect(graphOfText("on: push\njobs: [build]\n").warnings).toContain(
      "`jobs:` must be a mapping of job ids.",
    );
  });
});

describe("buildGraph simulation", () => {
  const CONDITIONAL = [
    "on: [push, pull_request]",
    "jobs:",
    "  build:",
    "  publish:",
    "    needs: build",
    "    if: github.event_name == 'push'",
  ].join("\n");

  it("marks each row with the state it would have for the selected event", () => {
    const onPush = graphOfText(CONDITIONAL, { simulation: { event: "push", inputs: {} } });
    expect(onPush.cards[1]?.rows[0]).toMatchObject({ jobId: "publish", state: "run" });

    const onPr = graphOfText(CONDITIONAL, { simulation: { event: "pull_request", inputs: {} } });
    expect(onPr.cards[1]?.rows[0]).toMatchObject({ jobId: "publish", state: "skipped" });
  });

  it("keeps a skipped job in place so the layout does not jump", () => {
    const onPush = graphOfText(CONDITIONAL, { simulation: { event: "push", inputs: {} } });
    const onPr = graphOfText(CONDITIONAL, { simulation: { event: "pull_request", inputs: {} } });
    expect(shape(onPr)).toEqual(shape(onPush));
  });

  it("explains why a row is skipped", () => {
    const graph = graphOfText(CONDITIONAL, { simulation: { event: "pull_request", inputs: {} } });
    expect(graph.cards[1]?.rows[0]?.reason).toContain("`if:` is false");
  });

  it("marks a row unknown when its condition cannot be decided", () => {
    const graph = graphOfText("on: push\njobs:\n  a:\n    if: secrets.TOKEN != ''\n", {
      simulation: { event: "push", inputs: {} },
    });
    expect(graph.cards[0]?.rows[0]?.state).toBe("unknown");
  });

  it("reacts to an input change", () => {
    const source = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      deploy:",
      "        type: boolean",
      "        default: false",
      "jobs:",
      "  ship:",
      "    if: inputs.deploy",
    ].join("\n");
    const off = graphOfText(source, { simulation: { event: "workflow_dispatch", inputs: {} } });
    expect(off.cards[0]?.rows[0]?.state).toBe("skipped");

    const on = graphOfText(source, {
      simulation: { event: "workflow_dispatch", inputs: { deploy: true } },
    });
    expect(on.cards[0]?.rows[0]?.state).toBe("run");
  });
});

describe("buildGraph step states", () => {
  it("carries each step's simulated state onto its row", () => {
    const source = [
      "on: [push, pull_request]",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: always",
      "      - run: push-only",
      "        if: github.event_name == 'push'",
    ].join("\n");

    const onPush = graphOfText(source, { simulation: { event: "push", inputs: {} } });
    expect(onPush.cards[0]?.rows[0]?.steps.map((step) => step.state)).toEqual(["run", "run"]);

    const onPr = graphOfText(source, { simulation: { event: "pull_request", inputs: {} } });
    expect(onPr.cards[0]?.rows[0]?.steps.map((step) => step.state)).toEqual(["run", "skipped"]);
  });
});
