import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActivePreviewSession,
  dispatchPreviewTestMessage,
  getPreviewTestState,
  renderPreviewForTest,
  setActivePreviewSession,
} from "../preview/previewTestBridge.js";
import type { PreviewController, PreviewState } from "../preview/previewController.js";

const STATE: PreviewState = { expanded: ["job:a"], direction: "LR" };

function fakeController(): PreviewController {
  return {
    render: vi.fn(async () => {}),
    handleMessage: vi.fn(async () => {}),
    requestExport: vi.fn(async () => {}),
    getState: vi.fn(() => STATE),
  };
}

beforeEach(() => {
  clearActivePreviewSession();
});

describe("previewTestBridge", () => {
  it("reports no state when no preview is registered", async () => {
    const owner = {};
    setActivePreviewSession({ owner, controller: fakeController() });
    clearActivePreviewSession(owner);
    expect(getPreviewTestState()).toBeUndefined();
    // Dispatching into an empty bridge must be a no-op, not a crash.
    await expect(dispatchPreviewTestMessage({ type: "ready" })).resolves.toBeUndefined();
    await expect(renderPreviewForTest()).resolves.toBeUndefined();
  });

  it("forwards state, messages and renders to the active controller", async () => {
    const controller = fakeController();
    setActivePreviewSession({ owner: {}, controller });
    expect(getPreviewTestState()).toBe(STATE);
    await dispatchPreviewTestMessage({ type: "toggleExpand", nodeId: "job:a" });
    expect(controller.handleMessage).toHaveBeenCalledWith({
      type: "toggleExpand",
      nodeId: "job:a",
    });
    await renderPreviewForTest();
    expect(controller.render).toHaveBeenCalled();
  });

  it("ignores a clear from a panel that is no longer the active one", () => {
    const controller = fakeController();
    const current = {};
    setActivePreviewSession({ owner: current, controller });
    clearActivePreviewSession({});
    expect(getPreviewTestState()).toBe(STATE);
    clearActivePreviewSession(current);
    expect(getPreviewTestState()).toBeUndefined();
  });
});
