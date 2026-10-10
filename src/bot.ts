import { Bot, InlineKeyboard, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { config } from "./config.js";
import type { Store, User } from "./store.js";
import * as litellm from "./litellm.js";
import * as sandbox from "./sandbox.js";
import { ONBOARDING_DIRECTIVE, runClaude } from "./claude.js";
import { LiveMessage } from "./live.js";

const DENY_MUTE_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

interface Runtime {
  texts: string[];
  timer?: NodeJS.Timeout;
  running?: { interrupted: boolean };
  chain: Promise<void>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createBot(store: Store) {
  const bot = new Bot(config.botToken);
  bot.api.config.use(autoRetry());

  const runtimes = new Map<number, Runtime>();
  const rt = (id: number): Runtime => {
    let r = runtimes.get(id);
    if (!r) runtimes.set(id, (r = { texts: [], chain: Promise.resolve() }));
    return r;
  };

  const isAdmin = (ctx: Context) => ctx.from?.id === config.adminId;
  const label = (u: User) => `${u.name}${u.username ? ` (@${u.username})` : ""} [${u.telegram_id}]`;

  async function tellAdmin(text: string, extra?: Parameters<typeof bot.api.sendMessage>[2]) {
    try {
      await bot.api.sendMessage(config.adminId, text.slice(0, 4000), extra);
    } catch (e) {
      console.error("could not notify admin:", errMsg(e));
    }
  }

  async function tell(id: number, text: string) {
    try {
      await bot.api.sendMessage(id, text);
    } catch (e) {
      console.error(`could not message ${id}:`, errMsg(e));
    }
  }

  /** Creates the LiteLLM key, network and container, then marks the user approved. */
  async function provision(id: number): Promise<User> {
    let u = store.get(id)!;
    if (!u.litellm_key) store.setKey(id, await litellm.createKey(id));
    if (u.net_idx == null) store.allocNet(id);
    u = store.get(id)!;
    await sandbox.ensureReady(u);
    store.setStatus(id, "approved");
    return store.get(id)!;
  }

  /** Sends the introduction straight after approval, without waiting for the user to write first. */
  function welcome(id: number) {
    if (store.get(id)?.onboarded) return;
    const r = rt(id);
    r.texts.push("[The user has just joined and has not written anything yet.]");
    r.chain = r.chain.then(() => runTurn(id, id)).catch((e) => console.error("welcome failed:", e));
  }

  async function interrupt(id: number) {
    const r = rt(id);
    if (!r.running || r.running.interrupted) return;
    r.running.interrupted = true;
    await sandbox.killTurn(id).catch((e) => console.error("kill failed:", errMsg(e)));
  }

  function requestAccess(ctx: Context, existing?: User) {
    const from = ctx.from!;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const u = existing ?? store.createPending(from.id, name, from.username ?? null);
    if (existing) store.setStatus(from.id, "pending");
    const kb = new InlineKeyboard().text("✅ تأیید", `approve:${from.id}`).text("🚫 رد", `deny:${from.id}`);
    void tellAdmin(`درخواست دسترسی جدید\n${label(u)}`, { reply_markup: kb });
    return ctx.reply("ممنون! از ادمین خواستم شما را وارد کند. به‌محض تأیید، همین‌جا به شما پیام می‌دهم.");
  }

  /** Returns the approved user, or null after having replied/ignored as appropriate. */
  async function gate(ctx: Context): Promise<User | null> {
    const from = ctx.from;
    if (!from) return null;
    let u = store.get(from.id);

    if (from.id === config.adminId && u?.status !== "approved") {
      if (!u) {
        const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
        store.createPending(from.id, name, from.username ?? null);
      }
      await ctx.reply("در حال آماده‌سازی محیط شما…");
      try {
        return await provision(from.id);
      } catch (e) {
        await ctx.reply(`راه‌اندازی ناموفق بود: ${errMsg(e)}`);
        return null;
      }
    }

    if (!u) {
      await requestAccess(ctx);
      return null;
    }
    switch (u.status) {
      case "approved":
        return u;
      case "pending":
        await ctx.reply("هنوز منتظر تأیید ادمین هستید.");
        return null;
      case "denied":
        if (Date.now() < u.denied_until) return null;
        await requestAccess(ctx, u);
        return null;
      case "revoked":
        await ctx.reply("دسترسی شما لغو شده است.");
        return null;
    }
  }

  // ---- the turn loop -------------------------------------------------------------

  function queueText(user: User, chatId: number, text: string) {
    const r = rt(user.telegram_id);
    r.texts.push(text);
    void interrupt(user.telegram_id);
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.chain = r.chain.then(() => runTurn(user.telegram_id, chatId)).catch((e) => console.error("turn failed:", e));
    }, config.debounceMs);
  }

  async function runTurn(id: number, chatId: number) {
    const r = rt(id);
    const texts = r.texts.splice(0);
    const user = store.get(id);
    if (!texts.length || !user || user.status !== "approved") return;

    const run = { interrupted: false };
    r.running = run;
    const typing = setInterval(() => void bot.api.sendChatAction(chatId, "typing").catch(() => {}), 4500);
    void bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const live = new LiveMessage(bot.api, chatId);
    live.set("⏳");

    try {
      await sandbox.ensureReady(user);
      const result = await runClaude({
        store,
        user,
        prompt: user.onboarded ? texts.join("\n\n") : `${ONBOARDING_DIRECTIVE}\n\n${texts.join("\n\n")}`,
        run,
        onDisplay: (t) => live.set(t),
      });

      let text = result.text;
      if (result.interrupted) {
        text = text ? `${text}\n\n⏹ متوقف شد.` : "⏹ متوقف شد.";
      } else if (result.error) {
        text = text ? `${text}\n\n⚠️ مشکلی پیش آمد.` : "⚠️ مشکلی از سمت من پیش آمد. ادمین مطلع شد.";
        void tellAdmin(`خطا در پاسخ‌دهی برای ${label(user)}:\n${result.error}`);
      }
      await live.finish(text || "(خروجی‌ای نبود)");
      if (!user.onboarded && !result.interrupted && !result.error) store.markOnboarded(id);
    } catch (e) {
      await live.finish("⚠️ مشکلی از سمت من پیش آمد. ادمین مطلع شد.");
      void tellAdmin(`اجرای پیام برای ${label(user)} با خطا متوقف شد:\n${errMsg(e)}`);
    } finally {
      clearInterval(typing);
      r.running = undefined;
    }
  }

  // ---- middleware ----------------------------------------------------------------

  // Direct messages only; groups and channels are ignored.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  // ---- approval buttons ----------------------------------------------------------

  bot.callbackQuery(/^(approve|deny):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
    const [, action, idStr] = ctx.match;
    const id = Number(idStr);
    const u = store.get(id);
    if (!u) return ctx.answerCallbackQuery({ text: "کاربر ناشناس" });

    if (action === "deny") {
      store.setDeniedUntil(id, Date.now() + DENY_MUTE_MS);
      await ctx.editMessageText(`🚫 رد شد: ${label(u)}`);
      await tell(id, "متأسفم، درخواست شما تأیید نشد.");
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery({ text: "در حال آماده‌سازی…" });
    try {
      await provision(id);
      await ctx.editMessageText(`✅ تأیید شد: ${label(u)}`);
      await tell(id, "شما وارد شدید! 🎉");
      welcome(id);
    } catch (e) {
      await ctx.editMessageText(`⚠️ تأیید ${label(u)} ناموفق بود: ${errMsg(e)}`);
    }
  });

  // ---- user commands -------------------------------------------------------------

  bot.command("start", async (ctx) => {
    const u = await gate(ctx);
    if (u) await ctx.reply("سلام! من سید هوش مصنوعی هستم. کافی است پیام بفرستید.\nدستورها:\n/stop — توقف پاسخ در حال اجرا\n/reset — شروع گفتگوی تازه\n/status — وضعیت");
  });

  bot.command("stop", async (ctx) => {
    const u = await gate(ctx);
    if (!u) return;
    const r = rt(u.telegram_id);
    r.texts.length = 0;
    clearTimeout(r.timer);
    if (!r.running) return ctx.reply("چیزی در حال اجرا نیست.");
    await interrupt(u.telegram_id);
  });

  bot.command("reset", async (ctx) => {
    const u = await gate(ctx);
    if (!u) return;
    const r = rt(u.telegram_id);
    r.texts.length = 0;
    clearTimeout(r.timer);
    await interrupt(u.telegram_id);
    await r.chain;
    store.resetSession(u.telegram_id);
    await ctx.reply("گفتگو بازنشانی شد. فایل‌های شما دست‌نخورده‌اند.");
  });

  bot.command("status", async (ctx) => {
    const u = await gate(ctx);
    if (!u) return;
    const state = await sandbox.containerState(u.telegram_id);
    const running = rt(u.telegram_id).running ? "در حال پاسخ‌دادن" : "آماده";
    await ctx.reply(`محیط: ${state}\nClaude: ${running}\nنشست: ${u.session_id.slice(0, 8)}`);
  });

  // ---- admin commands ------------------------------------------------------------

  const adminOnly = (fn: (ctx: Context, arg: string) => Promise<unknown>) => async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    const arg = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
    try {
      await fn(ctx, arg);
    } catch (e) {
      await ctx.reply(`ناموفق: ${errMsg(e)}`);
    }
  };

  const target = (arg: string): User => {
    const u = store.get(Number(arg));
    if (!u) throw new Error("شناسه‌ی تلگرامِ یک کاربر شناخته‌شده را بدهید (فهرست: /users)");
    return u;
  };

  bot.command(
    "users",
    adminOnly(async (ctx) => {
      const users = store.all();
      if (!users.length) return ctx.reply("هنوز کاربری نیست.");
      const lines = await Promise.all(
        users.map(async (u) => `${u.status.padEnd(8)} ${label(u)} — ${await sandbox.containerState(u.telegram_id)}`),
      );
      return ctx.reply(lines.join("\n"));
    }),
  );

  bot.command(
    "approve",
    adminOnly(async (ctx, arg) => {
      const u = target(arg);
      await provision(u.telegram_id);
      await tell(u.telegram_id, "شما وارد شدید! 🎉");
      welcome(u.telegram_id);
      return ctx.reply(`✅ تأیید شد: ${label(u)}`);
    }),
  );

  bot.command(
    "revoke",
    adminOnly(async (ctx, arg) => {
      const u = target(arg);
      await interrupt(u.telegram_id);
      if (u.litellm_key) await litellm.deleteKey(u.litellm_key).catch((e) => console.error(errMsg(e)));
      store.setKey(u.telegram_id, null);
      store.setStatus(u.telegram_id, "revoked");
      await sandbox.stopContainer(u.telegram_id);
      return ctx.reply(`دسترسی ${label(u)} لغو شد. داده‌های او نگه داشته شد؛ با /approve ${u.telegram_id} دسترسی برمی‌گردد.`);
    }),
  );

  bot.command(
    "restart",
    adminOnly(async (ctx, arg) => {
      const u = target(arg);
      await interrupt(u.telegram_id);
      await sandbox.stopContainer(u.telegram_id);
      await sandbox.ensureReady(u);
      return ctx.reply(`راه‌اندازی مجدد شد: ${label(u)}`);
    }),
  );

  bot.command(
    "recreate",
    adminOnly(async (ctx, arg) => {
      const targets = arg === "all" ? store.all().filter((u) => u.status === "approved") : [target(arg)];
      await ctx.reply("در حال دریافت جدیدترین ایمیج محیط…");
      await sandbox.ensureImage(true);
      for (const u of targets) {
        await interrupt(u.telegram_id);
        await sandbox.removeContainer(u.telegram_id);
        await sandbox.ensureReady(u);
      }
      return ctx.reply(`${targets.length} محیط از نو ساخته شد. داده‌ها نگه داشته شدند.`);
    }),
  );

  // ---- messages ------------------------------------------------------------------

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const u = await gate(ctx);
    if (u) queueText(u, ctx.chat.id, ctx.message.text);
  });

  async function receiveFile(ctx: Context, fileId: string, size: number | undefined, name: string, caption: string) {
    const u = await gate(ctx);
    if (!u) return;
    if ((size ?? 0) > MAX_DOWNLOAD_BYTES) return ctx.reply("این فایل از سقف ۲۰ مگابایتیِ دانلود ربات‌های تلگرام بزرگ‌تر است.");
    try {
      const file = await ctx.api.getFile(fileId);
      const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());
      await sandbox.ensureReady(u);
      const safe = `${Date.now()}-${name.replace(/[^\w.-]+/g, "_")}`;
      const path = await sandbox.putInboxFile(u.telegram_id, safe, data);
      queueText(u, ctx.chat!.id, `[The user sent a file, saved at ${path}]${caption ? `\n${caption}` : ""}`);
    } catch (e) {
      await ctx.reply("نتوانستم این فایل را دریافت کنم.");
      void tellAdmin(`دریافت فایل برای ${label(u)} ناموفق بود: ${errMsg(e)}`);
    }
  }

  bot.on("message:photo", (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    return receiveFile(ctx, photo.file_id, photo.file_size, "photo.jpg", ctx.message.caption ?? "");
  });

  bot.on("message:document", (ctx) => {
    const d = ctx.message.document;
    return receiveFile(ctx, d.file_id, d.file_size, d.file_name ?? "file", ctx.message.caption ?? "");
  });

  bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
    if (await gate(ctx)) await ctx.reply("پیام صوتی هنوز پشتیبانی نمی‌شود. لطفاً پیام را تایپ کنید.");
  });

  bot.catch((err) => console.error("bot error:", errMsg(err.error)));

  return bot;
}
