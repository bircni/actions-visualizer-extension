import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../workflow/parse.js";

const FIXTURE_DIR = path.join(process.cwd(), ".fixtures", "workflows");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

describe("parseWorkflow triggers", () => {
  it("parses a scalar `on:`", () => {
    const model = parseWorkflow("on: push\njobs:\n  a:\n    steps: []\n");
    expect(model.triggers).toEqual([
      {
        event: "push",
        details: [],
        branches: [],
        tags: [],
        inputs: [],
        range: expect.objectContaining({ start: expect.any(Number) }),
      },
    ]);
  });

  it("parses a sequence `on:`", () => {
    const model = parseWorkflow("on: [push, pull_request]\njobs:\n  a:\n    steps: []\n");
    expect(model.triggers.map((trigger) => trigger.event)).toEqual(["push", "pull_request"]);
  });

  it("parses a mapping `on:` with filters", () => {
    const model = parseWorkflow(
      "on:\n  push:\n    branches: [main, 'release/*']\n  workflow_dispatch:\njobs:\n  a:\n    steps: []\n",
    );
    expect(model.triggers[0]).toMatchObject({
      event: "push",
      details: ["branches: main, release/*"],
    });
    expect(model.triggers[1]).toMatchObject({ event: "workflow_dispatch", details: [] });
  });

  it("summarises schedule cron entries", () => {
    const model = parseWorkflow(fixture("reusable.yml"));
    expect(model.triggers).toMatchObject([{ event: "schedule", details: ["cron: 0 3 * * 1"] }]);
  });

  it("captures branch and tag filters for ref simulation", () => {
    const model = parseWorkflow(
      "on:\n  push:\n    branches: [main, dev]\n    tags: ['v*']\njobs:\n  a:\n    steps: []\n",
    );
    expect(model.triggers[0]).toMatchObject({ branches: ["main", "dev"], tags: ["v*"] });
  });

  it("parses workflow_dispatch inputs with their types and defaults", () => {
    const model = parseWorkflow(
      [
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      environment:",
        "        type: choice",
        "        description: Target",
        "        required: true",
        "        options: [staging, production]",
        "        default: staging",
        "      dry-run:",
        "        type: boolean",
        "        default: true",
        "      count:",
        "        type: number",
        "        default: '3'",
        "      bare:",
        "jobs:",
        "  a:",
        "    steps: []",
      ].join("\n"),
    );
    expect(model.triggers[0]?.inputs).toEqual([
      {
        name: "environment",
        type: "choice",
        required: true,
        description: "Target",
        default: "staging",
        options: ["staging", "production"],
      },
      { name: "dry-run", type: "boolean", required: false, default: true },
      { name: "count", type: "number", required: false, default: 3 },
      { name: "bare", type: "string", required: false },
    ]);
  });

  it("falls back to a string input for an unknown declared type", () => {
    const model = parseWorkflow(
      "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: nonsense\njobs:\n  a:\n    steps: []\n",
    );
    expect(model.triggers[0]?.inputs[0]).toMatchObject({ name: "x", type: "string" });
  });

  it("keeps a source range pointing at the trigger key", () => {
    const text = "name: X\non:\n  push:\njobs:\n  a:\n    steps: []\n";
    const range = parseWorkflow(text).triggers[0]?.range;
    expect(range).toBeDefined();
    expect(text.slice(range?.start ?? 0, range?.end ?? 0)).toBe("push");
  });
});

describe("parseWorkflow jobs", () => {
  it("normalises `needs:` given as a scalar", () => {
    const model = parseWorkflow("on: push\njobs:\n  a:\n    steps: []\n  b:\n    needs: a\n");
    expect(model.jobs.find((job) => job.id === "b")?.needs).toEqual(["a"]);
  });

  it("normalises `needs:` given as a sequence", () => {
    const model = parseWorkflow(fixture("fan-out.yml"));
    expect(model.jobs.find((job) => job.id === "publish")?.needs).toEqual(["lint", "test"]);
  });

  it("captures conditions, runners and environments", () => {
    const publish = parseWorkflow(fixture("fan-out.yml")).jobs.find((job) => job.id === "publish");
    expect(publish).toMatchObject({
      condition: "github.ref == 'refs/heads/main'",
      runsOn: "ubuntu-latest",
      environment: "production",
    });
  });

  it("renders `runs-on` given as a list or a group map", () => {
    const list = parseWorkflow("on: push\njobs:\n  a:\n    runs-on: [self-hosted, linux]\n");
    expect(list.jobs[0]?.runsOn).toBe("self-hosted, linux");
    const group = parseWorkflow(
      "on: push\njobs:\n  a:\n    runs-on:\n      group: builders\n      labels: [large]\n",
    );
    expect(group.jobs[0]?.runsOn).toBe("builders, large");
  });

  it("records a reusable workflow call", () => {
    const call = parseWorkflow(fixture("reusable.yml")).jobs.find((job) => job.id === "call");
    expect(call?.uses).toBe("./.github/workflows/simple.yml");
    expect(call?.steps).toEqual([]);
  });

  it("falls back to the job id when there is no explicit name", () => {
    const model = parseWorkflow("on: push\njobs:\n  build-and-test:\n    steps: []\n");
    expect(model.jobs[0]?.name).toBe("build-and-test");
  });

  it("keeps a source range pointing at the job key", () => {
    const text = fixture("simple.yml");
    const range = parseWorkflow(text).jobs[0]?.range;
    expect(text.slice(range?.start ?? 0, range?.end ?? 0)).toBe("build");
  });
});

describe("parseWorkflow steps", () => {
  it("names steps by `name`, then `uses`, then the first `run` line", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  a:",
        "    steps:",
        "      - name: Explicit",
        "        run: echo 1",
        "      - uses: actions/checkout@v5",
        "      - run: |",
        "          npm ci",
        "          npm test",
        "      - id: bare",
      ].join("\n"),
    );
    expect(model.jobs[0]?.steps.map((step) => step.name)).toEqual([
      "Explicit",
      "actions/checkout@v5",
      "npm ci",
      "step 4",
    ]);
  });

  it("flags run steps, conditions and continue-on-error", () => {
    const model = parseWorkflow(
      [
        "on: push",
        "jobs:",
        "  a:",
        "    steps:",
        "      - run: echo 1",
        "        if: always()",
        "        continue-on-error: true",
      ].join("\n"),
    );
    expect(model.jobs[0]?.steps[0]).toMatchObject({
      isRun: true,
      condition: "always()",
      continueOnError: true,
    });
  });

  it("truncates a very long run command used as a name", () => {
    const long = "echo ".repeat(40);
    const model = parseWorkflow(`on: push\njobs:\n  a:\n    steps:\n      - run: ${long}\n`);
    const name = model.jobs[0]?.steps[0]?.name ?? "";
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("parseWorkflow matrix", () => {
  it("counts static combinations", () => {
    const model = parseWorkflow(fixture("matrix.yml"));
    expect(model.jobs[0]?.matrix).toMatchObject({
      isDynamic: false,
      combinations: 4,
      axes: [
        { key: "os", values: ["ubuntu-latest", "macos-latest"] },
        { key: "node", values: ["20", "22"] },
      ],
    });
  });

  it("marks include/exclude and expression matrices as dynamic", () => {
    const withInclude = parseWorkflow(
      "on: push\njobs:\n  a:\n    strategy:\n      matrix:\n        os: [linux]\n        include:\n          - os: mac\n",
    );
    expect(withInclude.jobs[0]?.matrix?.isDynamic).toBe(true);
    expect(withInclude.jobs[0]?.matrix?.combinations).toBeUndefined();

    const expression = parseWorkflow(
      "on: push\njobs:\n  a:\n    strategy:\n      matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}\n",
    );
    expect(expression.jobs[0]?.matrix?.isDynamic).toBe(true);
  });
});

describe("parseWorkflow error handling", () => {
  it("reports a syntax error instead of throwing", () => {
    const model = parseWorkflow(fixture("broken.yml"));
    expect(model.fatalError).toBeTruthy();
    expect(model.jobs).toEqual([]);
  });

  it("rejects a top-level scalar document", () => {
    expect(parseWorkflow("just a string").fatalError).toContain("YAML mapping");
  });

  it("warns when a workflow has no jobs", () => {
    const model = parseWorkflow("on: push\n");
    expect(model.fatalError).toBeUndefined();
    expect(model.diagnostics).toContainEqual({
      severity: "warning",
      message: "The workflow declares no jobs.",
    });
  });

  it("reports a non-mapping `jobs:` key", () => {
    const model = parseWorkflow("on: push\njobs: [build]\n");
    expect(model.diagnostics).toContainEqual({
      severity: "error",
      message: "`jobs:` must be a mapping of job ids.",
    });
  });

  it("keeps `on:` a string rather than the YAML 1.1 boolean", () => {
    const model = parseWorkflow("on: push\njobs:\n  a:\n    steps: []\n");
    expect(model.triggers[0]?.event).toBe("push");
  });
});
