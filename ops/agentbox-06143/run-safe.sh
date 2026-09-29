#!/bin/sh
set -eu
w="$HOME/.cache/agent-tmp/omg-update-06143"
export OMG_SAFE_BACKUP_ROOT="$HOME/.local/state/omg-update-backups/update-06143"
export OMG_SAFE_UPDATE_CMD="python3 $w/deploy.py activate"
export OMG_SAFE_UPDATE_CHECK_CMD="python3 $w/deploy.py preflight"
export OMG_SAFE_RESTART_CMD="python3 $w/deploy.py restart"
export OMG_SAFE_HEALTH_CMD="python3 $w/deploy.py health"
export OMG_SAFE_WAIT_SECONDS=120
exec "$HOME/bin/omg-safe-update" "$@"
