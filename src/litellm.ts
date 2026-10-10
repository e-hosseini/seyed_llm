import { config } from "./config.js";

async function call(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${config.litellmUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.litellmMaster}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LiteLLM ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Creates a per-user virtual key with no budget, so usage is attributable and revocable. */
export async function createKey(telegramId: number): Promise<string> {
  const out = await call("/key/generate", {
    key_alias: `tg-${telegramId}-${Date.now()}`,
    metadata: { telegram_id: telegramId },
  });
  if (!out.key) throw new Error("LiteLLM did not return a key");
  return out.key as string;
}

export async function deleteKey(key: string): Promise<void> {
  await call("/key/delete", { keys: [key] });
}
