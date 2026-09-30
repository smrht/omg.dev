#!/bin/sh
set -eu
w="$HOME/.cache/agent-tmp/omg-update-06150"
export OMG_SAFE_BACKUP_ROOT="$HOME/.local/state/omg-update-backups/update-06150"
export OMG_SAFE_UPDATE_CMD="python3 $w/deploy.py activate"
export OMG_SAFE_UPDATE_CHECK_CMD="python3 $w/deploy.py preflight"
export OMG_SAFE_RESTART_CMD="python3 $w/deploy.py restart"
export OMG_SAFE_HEALTH_CMD="python3 $w/deploy.py health"
export OMG_SAFE_WAIT_SECONDS=120
export OMG_SAFE_EXTRA_CONFIGS="$HOME/.config/omg/agentbox-runs.env:$HOME/.config/executor/client.env:$HOME/.config/omg/worktree-reclaim.env:$HOME/.codex/config.toml:$HOME/.codex/auth.json:$HOME/.config/opencode/opencode.json:$HOME/.config/opencode/opencode.jsonc:$HOME/.local/share/opencode/auth.json"
exec "$HOME/bin/omg-safe-update" "$@"
