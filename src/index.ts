import { config } from "./config.js";
import { Store } from "./store.js";
import { createBot } from "./bot.js";
import * as sandbox from "./sandbox.js";

const store = new Store(config.dbPath);
const bot = createBot(store);

// The sandbox image is prebuilt and pulled from the registry; the bot never builds it.
await sandbox.ensureImage();

// Reattach to existing sandboxes rather than recreating them.
for (const u of store.all().filter((u) => u.status === "approved")) {
  try {
    await sandbox.ensureReady(u);
  } catch (e) {
    console.error(`could not start sandbox for ${u.telegram_id}:`, e instanceof Error ? e.message : e);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => void bot.stop());
}

await bot.start({
  onStart: (me) => console.log(`@${me.username} is up (long polling)`),
});
