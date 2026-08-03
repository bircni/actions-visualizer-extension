import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, setOutputChannel } from "../logger.js";
import type { OutputChannel } from "vscode";

function fakeChannel(): { channel: OutputChannel; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    channel: {
      appendLine: (line: string) => {
        lines.push(line);
      },
    } as unknown as OutputChannel,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("writes each level to the output channel", () => {
    const { channel, lines } = fakeChannel();
    setOutputChannel(channel);
    logger.info("started");
    logger.warn("careful");
    logger.error("broke");
    expect(lines).toEqual(["[INFO] started", "[WARN] careful", "[ERROR] broke"]);
  });

  it("appends structured payloads as JSON", () => {
    const { channel, lines } = fakeChannel();
    setOutputChannel(channel);
    logger.info("rendered", { nodes: 3 });
    logger.warn("slow", { ms: 1200 });
    expect(lines).toEqual(['[INFO] rendered {"nodes":3}', '[WARN] slow {"ms":1200}']);
  });

  it("narrows the many shapes an unknown error can take", () => {
    const { channel, lines } = fakeChannel();
    setOutputChannel(channel);
    logger.error("a", new Error("boom"));
    logger.error("b", { code: 42 });
    logger.error("c", "plain");
    logger.error("d", 7);
    logger.error("e", null);
    logger.error("f");
    expect(lines).toEqual([
      "[ERROR] a boom",
      '[ERROR] b {"code":42}',
      "[ERROR] c plain",
      "[ERROR] d 7",
      "[ERROR] e",
      "[ERROR] f",
    ]);
  });
});
