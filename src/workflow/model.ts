/**
 * Data model for a parsed GitHub / Gitea Actions workflow file.
 *
 * The model is deliberately a plain, serialisable structure: it travels from the
 * extension host to the webview over postMessage, so it must survive JSON round-trips.
 */

/** Byte offset range into the original YAML text, used to reveal a node's source. */
export type SourceRange = {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
};

/** A declared `workflow_dispatch` or `workflow_call` input. */
export type WorkflowInput = {
  name: string;
  description?: string;
  type: "string" | "boolean" | "number" | "choice" | "environment";
  /** Declared default, already coerced to the input's type. */
  default?: string | boolean | number;
  required: boolean;
  /** Allowed values for a `choice` input. */
  options?: string[];
};

/** A single `on:` trigger. */
export type WorkflowTrigger = {
  /** Event name, for example `push` or `workflow_dispatch`. */
  event: string;
  /** Human-readable qualifiers, for example `branches: main, release/*`. */
  details: string[];
  /** `branches:` filter, used to offer plausible refs when simulating this event. */
  branches: string[];
  /** `tags:` filter, used the same way. */
  tags: string[];
  /** Inputs declared for `workflow_dispatch` / `workflow_call`. */
  inputs: WorkflowInput[];
  range?: SourceRange;
};

/** A single step inside a job. */
export type WorkflowStep = {
  /** Display name: explicit `name`, else the action reference, else the first `run` line. */
  name: string;
  /** `uses:` reference when the step calls an action. */
  uses?: string;
  /** True when the step is a `run:` shell step. */
  isRun: boolean;
  /** `if:` expression when the step is conditional. */
  condition?: string;
  /** True when the step declares `continue-on-error`. */
  continueOnError: boolean;
  range?: SourceRange;
};

/** A `strategy.matrix` summary. */
export type WorkflowMatrix = {
  /** Matrix axis name to its values, `include`/`exclude` excluded. */
  axes: { key: string; values: string[] }[];
  /** Number of combinations, or undefined when it cannot be determined statically. */
  combinations?: number;
  /** True when the matrix uses expressions or include/exclude we cannot expand statically. */
  isDynamic: boolean;
};

/** A single entry under `jobs:`. */
export type WorkflowJob = {
  /** Job key as written in the YAML. */
  id: string;
  /** Explicit `name:`, falling back to the job id. */
  name: string;
  /** Job ids this job depends on, normalised to an array. */
  needs: string[];
  /** `if:` expression when the job is conditional. */
  condition?: string;
  /** `runs-on` rendered as a single string. */
  runsOn?: string;
  /** `environment` name when set. */
  environment?: string;
  /** `uses:` reference when this job calls a reusable workflow. */
  uses?: string;
  /** Matrix summary when `strategy.matrix` is present. */
  matrix?: WorkflowMatrix;
  steps: WorkflowStep[];
  range?: SourceRange;
};

/** A problem found while parsing that should be surfaced without blocking the graph. */
export type WorkflowDiagnostic = {
  severity: "error" | "warning";
  message: string;
};

/** The full parsed workflow. */
export type WorkflowModel = {
  /** `name:` when set. */
  name?: string;
  triggers: WorkflowTrigger[];
  jobs: WorkflowJob[];
  /** Non-fatal problems: unknown shapes, unresolved `needs`, and so on. */
  diagnostics: WorkflowDiagnostic[];
  /**
   * Set when the file could not be parsed at all. `jobs` is empty in that case;
   * the webview shows the message instead of a graph.
   */
  fatalError?: string;
};
