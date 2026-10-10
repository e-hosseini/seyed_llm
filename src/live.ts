import type { Api } from "grammy";
import { mdToTelegramHtml, splitText } from "./format.js";

const EDIT_INTERVAL_MS = 1000;

interface Sent {
  id: number;
  body: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One logical reply that is streamed into Telegram: a message edited about once a second,
 * rolling over into additional messages as the text outgrows Telegram's length cap.
 */
export class LiveMessage {
  private sent: Sent[] = [];
  private pending: string | null = null;
  private flushing: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  private lastFlush = 0;
  private closed = false;

  constructor(
    private api: Api,
    private chatId: number,
  ) {}

  set(text: string): void {
    this.pending = text;
    this.schedule();
  }

  async finish(text: string): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = text;
    await this.flushing;
    await this.flush();
  }

  private schedule(): void {
    if (this.closed || this.flushing || this.timer) return;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushing = this.flush().finally(() => {
        this.flushing = null;
        this.lastFlush = Date.now();
        if (this.pending !== null) this.schedule();
      });
    }, wait);
  }

  private async flush(): Promise<void> {
    const text = this.pending;
    if (text === null) return;
    this.pending = null;
    const parts = splitText(text || "…");
    for (let i = 0; i < parts.length; i++) {
      try {
        const cur = this.sent[i];
        if (!cur) this.sent.push(await this.send(parts[i]));
        else await this.edit(cur, parts[i]);
      } catch (e) {
        console.error("telegram update failed:", errText(e));
      }
    }
  }

  private async send(md: string): Promise<Sent> {
    const opts = { link_preview_options: { is_disabled: true } };
    try {
      const html = mdToTelegramHtml(md);
      const m = await this.api.sendMessage(this.chatId, html, { ...opts, parse_mode: "HTML" });
      return { id: m.message_id, body: md };
    } catch (e) {
      if (!/can't parse entities/i.test(errText(e))) throw e;
      const m = await this.api.sendMessage(this.chatId, md, opts);
      return { id: m.message_id, body: md };
    }
  }

  private async edit(cur: Sent, md: string): Promise<void> {
    if (cur.body === md) return;
    const opts = { link_preview_options: { is_disabled: true } };
    try {
      await this.api.editMessageText(this.chatId, cur.id, mdToTelegramHtml(md), { ...opts, parse_mode: "HTML" });
    } catch (e) {
      const msg = errText(e);
      if (/message is not modified/i.test(msg)) {
        // fine
      } else if (/can't parse entities/i.test(msg)) {
        await this.api.editMessageText(this.chatId, cur.id, md, opts);
      } else {
        throw e;
      }
    }
    cur.body = md;
  }
}
