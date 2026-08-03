/**
 * Generates the payloads the Playwright webview spec renders.
 *
 * They are produced by the real pipeline rather than hand-written, so the browser
 * tests can never drift from the shapes the extension host actually posts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildGraph } from "../src/workflow/graph.js";
import { layoutGraph } from "../src/workflow/layout.js";
import { parseWorkflow } from "../src/workflow/parse.js";
import {
  inputsFor,
  refChoicesFor,
  unresolvedPaths,
  withInputDefaults,
  type Simulation,
} from "../src/workflow/simulate.js";

const scriptDir = path.dirname(path.resolve(process.argv[1] ?? ""));
const rootDir = path.resolve(scriptDir, "..");
const fixtureDir = path.join(rootDir, ".fixtures", "workflows");
const targetDir = path.join(rootDir, ".tmp");
const targetPath = path.join(targetDir, "browser-fixture.json");

type Case = {
  file: string;
  event?: string;
  expanded?: string[];
  pinned?: Record<string, string>;
  ref?: string;
};

const CASES: Record<string, Case> = {
  fanOut: { file: "fan-out.yml" },
  showcase: { file: "showcase.yml" },
  simple: { file: "simple.yml" },
  simpleExpanded: { file: "simple.yml", expanded: ["row:build"] },
  dispatch: { file: "dispatch.yml", event: "workflow_dispatch" },
  conditionalPush: { file: "conditional.yml", event: "push" },
  conditionalPr: { file: "conditional.yml", event: "pull_request" },
  missingNeeds: { file: "missing-needs.yml" },
  broken: { file: "broken.yml" },
  gated: { file: "unknown-condition.yml" },
  gatedPinned: { file: "unknown-condition.yml", pinned: { "secrets.DEPLOY_KEY": "abc" } },
  stepConditions: { file: "step-conditions.yml", event: "pull_request", expanded: ["row:a"] },
  filtered: { file: "filtered.yml" },
  filteredMiss: { file: "filtered.yml", ref: "refs/heads/topic" },
};

function build(testCase: Case): unknown {
  const text = fs.readFileSync(path.join(fixtureDir, testCase.file), "utf8");
  const model = parseWorkflow(text);
  const event = testCase.event ?? model.triggers[0]?.event;
  const trigger = model.triggers.find((candidate) => candidate.event === event);
  const simulation: Simulation = {
    event,
    ref: testCase.ref ?? refChoicesFor(trigger)[0]?.ref,
    inputs: {},
    pinned: testCase.pinned ?? {},
  };
  const expanded = testCase.expanded ?? [];

  const graph = buildGraph(model, {
    fileName: testCase.file,
    showSteps: true,
    expandMatrix: false,
    simulation,
    expanded,
  });

  return {
    graph: layoutGraph(graph, { direction: "LR", expandedRows: expanded }),
    simulation: {
      event,
      ref: simulation.ref,
      refChoices: refChoicesFor(trigger),
      inputs: inputsFor(model, event),
      values: withInputDefaults(model, simulation),
      pinnable: [
        ...new Set([
          ...unresolvedPaths(model, simulation),
          ...Object.keys(simulation.pinned ?? {}),
        ]),
      ].toSorted(),
      pinned: simulation.pinned ?? {},
    },
  };
}

const payloads: Record<string, unknown> = {};
for (const [name, testCase] of Object.entries(CASES)) {
  payloads[name] = build(testCase);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(targetPath, JSON.stringify(payloads, null, 2));
console.log(`Wrote ${String(Object.keys(payloads).length)} browser fixtures to ${targetPath}`);
