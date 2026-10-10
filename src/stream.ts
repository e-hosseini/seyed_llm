interface Segment {
  kind: "text" | "tool";
  s: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const raw =
    input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description;
  const detail = typeof raw === "string" ? truncate(oneLine(raw).replaceAll("`", "'"), 80) : "";
  return detail ? `🔧 ${name}: \`${detail}\`` : `🔧 ${name}`;
}

/**
 * Turns Claude Code's `--output-format stream-json --include-partial-messages` events into
 * the text shown in Telegram: streamed answer text interleaved with one-line tool status.
 */
export class TurnRenderer {
  private segs: Segment[] = [];
  private deltaSeen = false;
  private breakText = true;

  gotInit = false;
  sessionId?: string;
  resultText?: string;
  isError = false;

  /** Feeds one parsed event. Returns true when the visible text changed. */
  ingest(ev: any): boolean {
    if (!ev || typeof ev !== "object") return false;

    if (ev.type === "system" && ev.subtype === "init") {
      this.gotInit = true;
      this.sessionId = ev.session_id;
      return false;
    }

    if (ev.type === "result") {
      this.resultText = typeof ev.result === "string" ? ev.result : undefined;
      this.isError = Boolean(ev.is_error) || String(ev.subtype ?? "").startsWith("error");
      if (ev.session_id) this.sessionId = ev.session_id;
      return false;
    }

    // Ignore sub-agent chatter; only the main conversation is shown.
    if (ev.parent_tool_use_id) return false;

    if (ev.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "message_start") {
        this.deltaSeen = false;
        this.breakText = true;
        return false;
      }
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
        this.deltaSeen = true;
        this.appendText(e.delta.text);
        return true;
      }
      return false;
    }

    if (ev.type === "assistant") {
      let changed = false;
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text && !this.deltaSeen) {
          this.segs.push({ kind: "text", s: block.text });
          changed = true;
        } else if (block.type === "tool_use") {
          this.segs.push({ kind: "tool", s: describeTool(block.name, block.input) });
          this.breakText = true;
          changed = true;
        }
      }
      return changed;
    }

    return false;
  }

  private appendText(t: string): void {
    const last = this.segs[this.segs.length - 1];
    if (!this.breakText && last?.kind === "text") {
      last.s += t;
    } else {
      this.segs.push({ kind: "text", s: t });
      this.breakText = false;
    }
  }

  display(): string {
    let out = "";
    this.segs.forEach((seg, i) => {
      if (i > 0) out += seg.kind === "tool" && this.segs[i - 1].kind === "tool" ? "\n" : "\n\n";
      out += seg.s;
    });
    return out.trim();
  }

  /** What to show once the run is over: streamed text, falling back to the result field. */
  finalText(): string {
    const shown = this.display();
    return shown || this.resultText?.trim() || "";
  }
}
