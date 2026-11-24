#!/usr/bin/env bash
# Run a "flask --app app ..." command as the narmada user with the server's settings.
# /etc/narmada.env is readable only by root (it holds the secret key), so root reads it
# here and passes the values on.  Usage (as root):  bash flask-cmd.sh list-users
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/narmada}"; ENV_FILE="${ENV_FILE:-/etc/narmada.env}"; APP_USER="${APP_USER:-narmada}"
[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)."; exit 1; }
[ -r "$ENV_FILE" ] || { echo "Missing $ENV_FILE – run install.sh first."; exit 1; }
vars=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; *=*) vars+=("$line") ;; esac
done < "$ENV_FILE"
cd "$APP_DIR"
exec sudo -u "$APP_USER" env "${vars[@]}" "$APP_DIR/.venv/bin/flask" --app app "$@"
