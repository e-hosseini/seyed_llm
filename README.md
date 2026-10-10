# aggs-chat

A Telegram bot that gives each approved user one permanent Claude Code conversation, running in
its own Docker sandbox.

```
Telegram ──► bot (grammY, SQLite) ──docker exec──► sandbox container (one per user)
                 │                                   claude -p --resume <session>
                 └─ admin API ─► LiteLLM ◄───────────  ANTHROPIC_BASE_URL (per-user virtual key)
                                    └─► Anthropic (the real API key lives only here)
```

## How it behaves

- **Access:** a new person messages the bot, you get Approve / Deny buttons. Approval creates their LiteLLM
  key, a private Docker network, a volume and a container. Denied users are muted for 24 h. DMs only.
- **One conversation per user:** every turn is `claude -p --resume <session-id>`; history lives in the
  user's volume, which is mounted as the container's home directory.
- **Messages:** a burst of messages is combined after 1.5 s of quiet. A message sent while Claude is working
  interrupts that turn. Photos and documents land in `~/inbox/` and Claude is told the path.
- **User commands:** `/stop` `/reset` `/status`
- **Admin commands:** `/users` `/approve <id>` `/revoke <id>` `/restart <id>` `/recreate <id|all>`
  (`/recreate` pulls the newest sandbox image; volumes are kept).

## Deploy

1. Push this repo to GitHub (private). The `build-images` workflow publishes
   `ghcr.io/<owner>/<repo>/bot` and `.../sandbox` (sandbox rebuilds weekly with the newest Claude Code).
2. On the VPS (Docker + compose installed), copy `docker-compose.yml`, `litellm/config.yaml`,
   `scripts/firewall.sh` and a filled-in `.env` (see `.env.example`).
3. Log in to GHCR so compose can pull the private bot image:
   `echo $GHCR_TOKEN | docker login ghcr.io -u $GHCR_USER --password-stdin`
   (the bot uses `GHCR_USER` / `GHCR_TOKEN` from `.env` to pull the sandbox image itself).
4. `sudo ./firewall.sh`, then `docker compose up -d`.
5. Message your bot from the admin account. The first message sets up your own sandbox.

## Security notes

- The Anthropic key is only in LiteLLM. Sandboxes get a per-user virtual key and can reach only
  LiteLLM and the internet. Deleting the key (`/revoke`) cuts model access immediately.
- Sandboxes run non-root with all capabilities dropped, `no-new-privileges`, and CPU / memory / pid limits.
- `scripts/firewall.sh` is required: without it a sandbox could reach services on the VPS itself.
- The bot holds the Docker socket, which is root-equivalent on the host. Keep the bot code trusted.
- Per-user **disk quotas are not enforced** (Docker volumes need XFS project quotas for that).
  Watch `docker system df -v`.
- Interrupting a turn terminates `claude`, but a long-running command it started may keep running
  until the container's pid limit or a restart stops it.

## Develop

```
npm install
npm test
npm run build
```
