/**
 * Test-only hook into the active preview panel.
 *
 * The extension-host e2e tests cannot reach inside a webview, so the panel
 * registers itself here and the tests drive it through the `__test.*` commands
 * registered in `extension.ts` (gated behind an environment variable).
 */

import type { PreviewController, PreviewState, WebviewHostMessage } from "./previewController.js";

type PreviewSession = {
  /** The panel that owns this session, used so a stale panel cannot clear a newer one. */
  owner: unknown;
  controller: PreviewController;
};

let activeSession: PreviewSession | undefined;

export function setActivePreviewSession(session: PreviewSession): void {
  activeSession = session;
}

export function clearActivePreviewSession(owner: unknown): void {
  if (activeSession?.owner === owner) {
    activeSession = undefined;
  }
}

/** Current controller state, or undefined when no preview is open. */
export function getPreviewTestState(): PreviewState | undefined {
  return activeSession?.controller.getState();
}

/** Delivers a message as if the webview had sent it. */
export async function dispatchPreviewTestMessage(message: WebviewHostMessage): Promise<void> {
  await activeSession?.controller.handleMessage(message);
}

/** Re-renders the active preview, used to wait out a debounce deterministically. */
export async function renderPreviewForTest(): Promise<void> {
  await activeSession?.controller.render();
}
