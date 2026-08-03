/**
 * Turns a {@link WorkflowModel} into an abstract graph of *cards*, mirroring how
 * GitHub draws a workflow run.
 *
 * GitHub does not draw one box per job. Jobs that sit at the same depth and share
 * the same `needs:` are drawn as rows inside a single rounded card, and edges run
 * card to card. Matrix jobs get their own card with a tab above it. This module
 * reproduces that grouping; layout then positions the cards.
 */

import { simulateJobs, type JobState, type Simulation } from "./simulate.js";
import type { SourceRange, WorkflowJob, WorkflowMatrix, WorkflowModel } from "./model.js";

/** Upper bound on rows produced by expanding a matrix, to keep a card readable. */
export const MAX_EXPANDED_MATRIX_ROWS = 50;

type CardKind = "jobs" | "matrix" | "missing";

/** One job rendered as a row inside a card. */
type CardRow = {
  /** Stable id used for expansion state and click targets. */
  id: string;
  jobId: string;
  title: string;
  /** Right-aligned muted text — the slot GitHub uses for a run's duration. */
  meta?: string;
  state: JobState;
  /** Why the row is in its state, shown on hover. */
  reason?: string;
  /** `if:` expression, shown beneath the row when it is expanded. */
  condition?: string;
  /** Reusable workflow reference, when the job calls one. */
  uses?: string;
  steps: {
    name: string;
    kind: "run" | "uses" | "other";
    conditional: boolean;
    /** Whether this step would run for the simulated event. */
    state: JobState;
  }[];
  range?: SourceRange;
};

export type GraphCard = {
  id: string;
  kind: CardKind;
  /** Tab label drawn above the card, e.g. `Matrix: build`. */
  tab?: string;
  rows: CardRow[];
  /** True when the card can be expanded to show one row per matrix combination. */
  expandable: boolean;
  expanded: boolean;
};

export type GraphEdge = {
  from: string;
  to: string;
  /** True when no job behind this edge would run, so it can be drawn faded. */
  inactive: boolean;
  /** True when the edge points at a `needs:` target that does not exist. */
  broken: boolean;
};

/** Everything the header above the graph needs. */
export type GraphHeader = {
  /** Workflow `name:`, falling back to the file name. */
  title: string;
  /** File name, so the user always knows which file they are looking at. */
  fileName: string;
  triggers: { event: string; details: string[]; selected: boolean; range?: SourceRange }[];
};

export type GraphModel = {
  header: GraphHeader;
  cards: GraphCard[];
  edges: GraphEdge[];
  warnings: string[];
  error?: string;
};

export type BuildGraphOptions = {
  fileName: string;
  showSteps: boolean;
  expandMatrix: boolean;
  simulation: Simulation;
  /** Ids of cards and rows the user has expanded. */
  expanded: string[];
};

const MISSING_CARD_ID = "card:missing";

/** Cartesian product of the matrix axes, capped at {@link MAX_EXPANDED_MATRIX_ROWS}. */
function matrixCombinations(matrix: WorkflowMatrix): Record<string, string>[] {
  let combinations: Record<string, string>[] = [{}];
  for (const axis of matrix.axes) {
    const next: Record<string, string>[] = [];
    for (const combination of combinations) {
      for (const value of axis.values) {
        next.push({ ...combination, [axis.key]: value });
      }
    }
    combinations = next;
    if (combinations.length > MAX_EXPANDED_MATRIX_ROWS) {
      return combinations.slice(0, MAX_EXPANDED_MATRIX_ROWS);
    }
  }
  return combinations;
}

/**
 * Depth of each job: 0 for a job with no `needs:`, otherwise one past its deepest
 * dependency. Iterative with a bounded number of passes so a `needs:` cycle settles
 * instead of recursing forever.
 */
function computeRanks(jobs: WorkflowJob[]): Map<string, number> {
  const known = new Set(jobs.map((job) => job.id));
  const ranks = new Map(jobs.map((job) => [job.id, 0]));
  for (let pass = 0; pass < jobs.length; pass += 1) {
    let changed = false;
    for (const job of jobs) {
      let rank = 0;
      for (const need of job.needs) {
        if (known.has(need)) {
          rank = Math.max(rank, (ranks.get(need) ?? 0) + 1);
        }
      }
      if (rank !== ranks.get(job.id)) {
        ranks.set(job.id, rank);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return ranks;
}

/** Right-aligned muted text for a row: the runner, or a note for reusable calls. */
function jobMeta(job: WorkflowJob): string | undefined {
  return job.uses == null ? job.runsOn : "reusable workflow";
}

function jobSteps(job: WorkflowJob, showSteps: boolean, states: JobState[]): CardRow["steps"] {
  if (!showSteps) {
    return [];
  }
  return job.steps.map((step, index) => ({
    name: step.name,
    kind: step.isRun ? "run" : step.uses == null ? "other" : "uses",
    conditional: step.condition != null,
    state: states[index] ?? "run",
  }));
}

/** Job ids that take part in a `needs:` cycle. */
function findCycles(jobs: WorkflowJob[]): string[][] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const stack: string[] = [];

  const visit = (id: string): void => {
    const status = state.get(id);
    if (status === "done") {
      return;
    }
    if (status === "visiting") {
      const start = stack.indexOf(id);
      cycles.push(stack.slice(start === -1 ? 0 : start));
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (byId.has(need)) {
        visit(need);
      }
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const job of jobs) {
    visit(job.id);
  }
  return cycles;
}

/** Builds the card graph for a parsed workflow. */
export function buildGraph(model: WorkflowModel, options: BuildGraphOptions): GraphModel {
  const header: GraphHeader = {
    title: model.name ?? options.fileName,
    fileName: options.fileName,
    triggers: model.triggers.map((trigger) => ({
      event: trigger.event,
      details: trigger.details,
      selected: trigger.event === options.simulation.event,
      ...(trigger.range == null ? {} : { range: trigger.range }),
    })),
  };

  if (model.fatalError != null) {
    return { header, cards: [], edges: [], warnings: [], error: model.fatalError };
  }

  const warnings: string[] = [];
  const jobIds = new Set(model.jobs.map((job) => job.id));
  const simulation = simulateJobs(model, options.simulation);
  const ranks = computeRanks(model.jobs);
  const expandedIds = new Set(options.expanded);

  /** Card each job's rows live in, so edges can be mapped from job dependencies. */
  const cardIdByJobId = new Map<string, string>();
  const cardsById = new Map<string, GraphCard>();
  const orderedCardIds: string[] = [];

  const ensureCard = (id: string, kind: CardKind, tab?: string): GraphCard => {
    const existing = cardsById.get(id);
    if (existing) {
      return existing;
    }
    const card: GraphCard = {
      id,
      kind,
      ...(tab == null ? {} : { tab }),
      rows: [],
      expandable: false,
      expanded: expandedIds.has(id),
    };
    cardsById.set(id, card);
    orderedCardIds.push(id);
    return card;
  };

  for (const job of model.jobs) {
    const outcome = simulation.get(job.id);
    const meta = jobMeta(job);
    const baseRow = {
      jobId: job.id,
      state: outcome?.state ?? "run",
      ...(outcome?.reason == null ? {} : { reason: outcome.reason }),
      ...(job.condition == null ? {} : { condition: job.condition }),
      ...(job.uses == null ? {} : { uses: job.uses }),
      ...(meta == null ? {} : { meta }),
      steps: jobSteps(job, options.showSteps, outcome?.steps ?? []),
      ...(job.range == null ? {} : { range: job.range }),
    };

    if (job.matrix) {
      const cardId = `card:matrix:${job.id}`;
      const card = ensureCard(cardId, "matrix", `Matrix: ${job.id}`);
      cardIdByJobId.set(job.id, cardId);
      card.expandable = !job.matrix.isDynamic && job.matrix.axes.length > 0;

      if (!card.expandable || !(card.expanded || options.expandMatrix)) {
        const count = job.matrix.combinations;
        card.rows.push({
          ...baseRow,
          id: `row:${job.id}`,
          title: count == null ? `${job.name} (matrix)` : `${String(count)} jobs`,
        });
        continue;
      }

      const combinations = matrixCombinations(job.matrix);
      if (job.matrix.combinations != null && combinations.length < job.matrix.combinations) {
        warnings.push(
          `Job \`${job.id}\` has ${String(job.matrix.combinations)} matrix combinations; only the first ${String(MAX_EXPANDED_MATRIX_ROWS)} are shown.`,
        );
      }
      for (const combination of combinations) {
        const label = Object.values(combination).join(", ");
        // The combination already says what varies, so the runner would only
        // repeat itself and crowd out the label.
        const { meta: _runner, ...withoutRunner } = baseRow;
        card.rows.push({
          ...withoutRunner,
          id: `row:${job.id}#${label}`,
          title: `${job.name} (${label})`,
        });
      }
      continue;
    }

    // Jobs at the same depth with the same dependencies share a card, which is
    // exactly the grouping GitHub shows.
    const rank = ranks.get(job.id) ?? 0;
    const cardId = `card:group:${String(rank)}:${[...job.needs].toSorted().join(",")}`;
    const card = ensureCard(cardId, "jobs");
    cardIdByJobId.set(job.id, cardId);
    card.rows.push({ ...baseRow, id: `row:${job.id}`, title: job.name });
  }

  // `needs:` targets that do not exist get their own card so the break is visible.
  const missingIds = new Set<string>();
  for (const job of model.jobs) {
    for (const need of job.needs) {
      if (jobIds.has(need) || missingIds.has(need)) {
        continue;
      }
      missingIds.add(need);
      const card = ensureCard(MISSING_CARD_ID, "missing");
      card.rows.push({
        id: `row:missing:${need}`,
        jobId: need,
        title: need,
        meta: "no such job",
        state: "skipped",
        reason: "This job is referenced by `needs:` but never defined.",
        steps: [],
      });
      cardIdByJobId.set(need, MISSING_CARD_ID);
      warnings.push(`Job \`${job.id}\` needs \`${need}\`, which is not defined in this workflow.`);
    }
  }

  // Card-to-card edges, deduplicated across the jobs behind them.
  const edgeStates = new Map<string, { inactive: boolean; broken: boolean }>();
  for (const job of model.jobs) {
    const toCard = cardIdByJobId.get(job.id);
    if (toCard == null) {
      continue;
    }
    for (const need of job.needs) {
      const fromCard = cardIdByJobId.get(need);
      if (fromCard == null || fromCard === toCard) {
        continue;
      }
      const key = `${fromCard} ${toCard}`;
      const broken = !jobIds.has(need);
      const inactive = (simulation.get(job.id)?.state ?? "run") === "skipped";
      const existing = edgeStates.get(key);
      edgeStates.set(key, {
        // An edge is only faded when every dependency behind it is inactive.
        inactive: existing ? existing.inactive && inactive : inactive,
        broken: existing ? existing.broken || broken : broken,
      });
    }
  }

  const edges: GraphEdge[] = [...edgeStates].map(([key, state]) => {
    const [from = "", to = ""] = key.split(" ");
    return { from, to, inactive: state.inactive, broken: state.broken };
  });

  for (const cycle of findCycles(model.jobs)) {
    warnings.push(`Circular \`needs:\` dependency: ${cycle.join(" → ")} → ${cycle[0] ?? ""}.`);
  }
  for (const diagnostic of model.diagnostics) {
    warnings.push(diagnostic.message);
  }

  const cards = orderedCardIds
    .map((id) => cardsById.get(id))
    .filter((card): card is GraphCard => card != null);

  const graph: GraphModel = { header, cards, edges, warnings };
  if (cards.length === 0) {
    graph.error = "This workflow defines no jobs to visualize.";
  }
  return graph;
}
