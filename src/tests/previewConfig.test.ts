import { beforeEach, describe, expect, it, vi } from "vitest";

/** Values the fake `workspace.getConfiguration` hands back, keyed by setting name. */
let configValues: Record<string, unknown> = {};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => configValues[key],
    }),
  },
}));

const {
  DEFAULT_UPDATE_DELAY_MS,
  MAX_UPDATE_DELAY_MS,
  clampUpdateDelayMs,
  normalizeDirection,
  normalizeStepDisplay,
  readPreviewSettings,
} = await import("../preview/previewConfig.js");

describe("clampUpdateDelayMs", () => {
  it("keeps a value inside the supported range", () => {
    expect(clampUpdateDelayMs(300)).toBe(300);
    expect(clampUpdateDelayMs(-100)).toBe(0);
    expect(clampUpdateDelayMs(99_999)).toBe(MAX_UPDATE_DELAY_MS);
  });

  it("rounds fractions and falls back for non-finite input", () => {
    expect(clampUpdateDelayMs(250.7)).toBe(251);
    expect(clampUpdateDelayMs(Number.NaN)).toBe(DEFAULT_UPDATE_DELAY_MS);
    expect(clampUpdateDelayMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_UPDATE_DELAY_MS);
  });
});

describe("normalizeStepDisplay", () => {
  it("accepts the known values and falls back to collapsed", () => {
    expect(normalizeStepDisplay("expanded")).toBe("expanded");
    expect(normalizeStepDisplay("never")).toBe("never");
    expect(normalizeStepDisplay("collapsed")).toBe("collapsed");
    expect(normalizeStepDisplay("nonsense")).toBe("collapsed");
    expect(normalizeStepDisplay(42)).toBe("collapsed");
  });
});

describe("normalizeDirection", () => {
  it("accepts TB and falls back to LR", () => {
    expect(normalizeDirection("TB")).toBe("TB");
    expect(normalizeDirection("LR")).toBe("LR");
    expect(normalizeDirection(null)).toBe("LR");
  });
});

describe("readPreviewSettings", () => {
  beforeEach(() => {
    configValues = {};
  });

  it("returns the documented defaults when nothing is configured", () => {
    expect(readPreviewSettings()).toEqual({
      showSteps: "collapsed",
      expandMatrix: false,
      direction: "LR",
      liveUpdate: true,
      updateDelayMs: DEFAULT_UPDATE_DELAY_MS,
    });
  });

  it("reads configured values", () => {
    configValues = {
      showSteps: "expanded",
      expandMatrix: true,
      direction: "TB",
      liveUpdate: false,
      updateDelayMs: 1200,
    };
    expect(readPreviewSettings()).toEqual({
      showSteps: "expanded",
      expandMatrix: true,
      direction: "TB",
      liveUpdate: false,
      updateDelayMs: 1200,
    });
  });

  it("ignores values of the wrong type", () => {
    configValues = { liveUpdate: 1, updateDelayMs: "fast" };
    expect(readPreviewSettings()).toMatchObject({
      liveUpdate: true,
      updateDelayMs: DEFAULT_UPDATE_DELAY_MS,
    });
  });

  it("clamps an out-of-range delay", () => {
    configValues = { updateDelayMs: 60_000 };
    expect(readPreviewSettings().updateDelayMs).toBe(MAX_UPDATE_DELAY_MS);
  });
});
