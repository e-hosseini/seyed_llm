import { describe, expect, it } from "vitest";
import { TurnRenderer, describeTool } from "./stream.js";

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

describe("TurnRenderer", () => {
  it("streams text, shows tool lines, and keeps later text separate", () => {
    const r = new TurnRenderer();
    r.ingest({ type: "system", subtype: "init", session_id: "s1" });
    r.ingest({ type: "stream_event", event: { type: "message_start" } });
    r.ingest(delta("Let me "));
    r.ingest(delta("check."));
    r.ingest({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    });
    r.ingest({ type: "stream_event", event: { type: "message_start" } });
    r.ingest(delta("Done."));
    r.ingest({ type: "result", subtype: "success", result: "Done.", session_id: "s1" });

    expect(r.gotInit).toBe(true);
    expect(r.display()).toBe("Let me check.\n\n🔧 Bash: `ls -la`\n\nDone.");
    expect(r.isError).toBe(false);
  });

  it("falls back to assistant text when no partial deltas arrive", () => {
    const r = new TurnRenderer();
    r.ingest({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    expect(r.display()).toBe("hello");
  });

  it("ignores sub-agent events and flags errors", () => {
    const r = new TurnRenderer();
    r.ingest({ ...delta("hidden"), parent_tool_use_id: "t1" });
    r.ingest({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
    expect(r.display()).toBe("");
    expect(r.isError).toBe(true);
    expect(r.finalText()).toBe("boom");
  });
});

describe("describeTool", () => {
  it("shortens multi-line commands and strips backticks", () => {
    expect(describeTool("Bash", { command: "echo `x`\nls" })).toBe("🔧 Bash: `echo 'x' ls`");
    expect(describeTool("Task", {})).toBe("🔧 Task");
  });
});
