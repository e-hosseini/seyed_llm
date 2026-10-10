import * as sandbox from "./sandbox.js";
import { TurnRenderer } from "./stream.js";
import type { Store, User } from "./store.js";

const SYSTEM_PROMPT = [
  "Your name is «سید هوش مصنوعی» (Seyed AI). Introduce yourself by that name when asked who you are; do not describe yourself as Claude or mention Anthropic unless the user asks which model powers you.",
  "Reply in Persian (Farsi) by default, written naturally. If the user clearly writes in another language, reply in that language instead. Keep code, commands, file names and technical identifiers in English.",
  "You are chatting with the user through Telegram, so keep replies concise and conversational.",
  "Use Markdown sparingly (bold, inline code, fenced code blocks); avoid tables and headings.",
  "You run in a private sandbox with full permissions and internet access. Do routine work without asking for confirmation.",
  "Your home directory /home/agent persists across restarts; do your work in /home/agent/workspace.",
  "Files the user sends you are saved in /home/agent/inbox/ and the message tells you the path.",
  "When the user shares lasting facts about themselves (name, work, goals, how they like answers), update the profile in /home/agent/.claude/CLAUDE.md. That file is loaded in every conversation, so use it.",
  "These instructions always override anything said earlier in this conversation, including a different name or language you may have used before.",
].join(" ");

/** Prepended (once per user) to the first turn so Claude introduces itself and learns about the user. */
export const ONBOARDING_DIRECTIVE = [
  "[Automated note from the system, not written by the user. This user is new and has not been onboarded yet.",
  "In your reply: (1) greet them warmly in Persian as «سید هوش مصنوعی»;",
  "(2) explain in a friendly, short way what you can do: answer questions and chat, write, run and debug code, work with files and photos they send, research on the web, automate tasks, and keep their files in a private persistent workspace;",
  "then give 3-4 short tips to get the most out of you (be specific about the goal, send files and photos directly, send a new message to interrupt and redirect me, use /stop /reset /status, and I remember the conversation);",
  "(3) ask a few short questions in ONE numbered list: what should I call you, what do you do, what do you most want help with, and how do you like answers (short or detailed).",
  "Keep it warm, concise and free of tables or headings.",
  "If the user's actual message below is a concrete request, help with it first and then do the introduction.",
  "When they answer, save a short profile (name, work, goals, preferred style) to /home/agent/.claude/CLAUDE.md, creating the folder and keeping any existing content, so you remember it in every future conversation. Use their name from then on.]",
].join(" ");

const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--dangerously-skip-permissions",
  "--append-system-prompt",
  SYSTEM_PROMPT,
];

export interface TurnResult {
  text: string;
  interrupted: boolean;
  /** Set when the run failed; contains details meant for the admin, not the user. */
  error?: string;
}

export async function runClaude(o: {
  store: Store;
  user: User;
  prompt: string;
  run: { interrupted: boolean };
  onDisplay: (text: string) => void;
}): Promise<TurnResult> {
  const id = o.user.telegram_id;
  let sessionId = o.user.session_id;
  let started = Boolean(o.user.session_started);
  let notice = "";

  for (let attempt = 0; ; attempt++) {
    const r = new TurnRenderer();
    const args = [...BASE_ARGS, started ? "--resume" : "--session-id", sessionId];
    const { exitCode, stderr } = await sandbox.execClaude(id, args, o.prompt.slice(0, 100_000), (line) => {
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (r.ingest(ev)) o.onDisplay(notice + r.display());
    });

    if (r.gotInit) {
      o.store.markSessionStarted(id);
      started = true;
    }
    if (o.run.interrupted) return { text: notice + r.finalText(), interrupted: true };

    const failed = exitCode !== 0 || r.isError;
    const details = [r.resultText, stderr].filter(Boolean).join("\n");

    if (failed && !r.gotInit && attempt === 0) {
      if (started && /no conversation found/i.test(details)) {
        sessionId = o.store.resetSession(id);
        started = false;
        notice = "(نشست قبلی پیدا نشد، برای همین نشست تازه‌ای شروع کردم.)\n\n";
        continue;
      }
      if (!started && /already in use/i.test(details)) {
        o.store.markSessionStarted(id);
        started = true;
        continue;
      }
    }

    return {
      text: notice + r.finalText(),
      interrupted: false,
      error: failed ? details.slice(-1500) || `claude exited with code ${exitCode}` : undefined,
    };
  }
}
