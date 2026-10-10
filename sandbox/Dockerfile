FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget ca-certificates openssh-client \
      python3 python3-pip python3-venv build-essential \
      ripgrep jq unzip zip less vim-tiny procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Replace the stock `node` user (uid 1000) with `agent`. Claude refuses
# --dangerously-skip-permissions as root, so the sandbox must run non-root.
# The home layout is created here so a fresh per-user volume inherits it.
RUN userdel -r node \
    && useradd -m -u 1000 -s /bin/bash agent \
    && mkdir -p /home/agent/workspace /home/agent/inbox \
    && chown -R agent:agent /home/agent

USER agent
ENV HOME=/home/agent \
    NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:$PATH
WORKDIR /home/agent/workspace

CMD ["sleep", "infinity"]
