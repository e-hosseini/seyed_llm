function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  botToken: req("TELEGRAM_BOT_TOKEN"),
  adminId: Number(req("ADMIN_TELEGRAM_ID")),
  litellmUrl: process.env.LITELLM_URL ?? "http://litellm:4000",
  litellmMaster: req("LITELLM_MASTER_KEY"),
  litellmContainer: process.env.LITELLM_CONTAINER ?? "litellm",
  sandboxImage: req("SANDBOX_IMAGE"),
  sandboxModel: process.env.SANDBOX_MODEL ?? "claude-sonnet-5-5",
  sandboxSmallModel: process.env.SANDBOX_SMALL_MODEL ?? "claude-haiku-5-5",
  ghcrUser: process.env.GHCR_USER,
  ghcrToken: process.env.GHCR_TOKEN,
  dbPath: process.env.DB_PATH ?? "/data/aggs.db",
  memoryBytes: Number(process.env.SANDBOX_MEMORY_GB ?? "2") * 1024 ** 3,
  cpus: Number(process.env.SANDBOX_CPUS ?? "1"),
  pids: Number(process.env.SANDBOX_PIDS ?? "512"),
  debounceMs: Number(process.env.DEBOUNCE_MS ?? "1500"),
};

if (!Number.isInteger(config.adminId)) {
  throw new Error("ADMIN_TELEGRAM_ID must be a numeric Telegram user id");
}
