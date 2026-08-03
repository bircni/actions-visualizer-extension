/**
 * Reads and clamps the `actions-visualizer.*` settings.
 *
 * Every getter is defensive: a user can put anything in settings.json, and a bad
 * value should degrade to the default rather than break the preview.
 */

import * as vscode from "vscode";
import type { LayoutDirection } from "../workflow/layout.js";

const CONFIG_SECTION = "actions-visualizer";

export const DEFAULT_UPDATE_DELAY_MS = 300;
const MIN_UPDATE_DELAY_MS = 0;
export const MAX_UPDATE_DELAY_MS = 5000;

/** How much step detail job nodes start with. */
export type StepDisplay = "collapsed" | "expanded" | "never";

/** Everything the preview needs from settings, resolved once per render. */
export type PreviewSettings = {
  showSteps: StepDisplay;
  expandMatrix: boolean;
  direction: LayoutDirection;
  liveUpdate: boolean;
  updateDelayMs: number;
};

export function clampUpdateDelayMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_UPDATE_DELAY_MS;
  }
  return Math.min(Math.max(Math.round(value), MIN_UPDATE_DELAY_MS), MAX_UPDATE_DELAY_MS);
}

export function normalizeStepDisplay(value: unknown): StepDisplay {
  return value === "expanded" || value === "never" ? value : "collapsed";
}

export function normalizeDirection(value: unknown): LayoutDirection {
  return value === "TB" ? "TB" : "LR";
}

function readBoolean(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean,
): boolean {
  const value = config.get<unknown>(key);
  return typeof value === "boolean" ? value : fallback;
}

/** Reads all preview settings, scoped to the workflow file when one is given. */
export function readPreviewSettings(scope?: vscode.Uri): PreviewSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, scope ?? null);
  const delay = config.get<unknown>("updateDelayMs");
  return {
    showSteps: normalizeStepDisplay(config.get<unknown>("showSteps")),
    expandMatrix: readBoolean(config, "expandMatrix", false),
    direction: normalizeDirection(config.get<unknown>("direction")),
    liveUpdate: readBoolean(config, "liveUpdate", true),
    updateDelayMs: clampUpdateDelayMs(typeof delay === "number" ? delay : DEFAULT_UPDATE_DELAY_MS),
  };
}
