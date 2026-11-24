#!/usr/bin/env bash
# Manage accounts from the server's command line.
#   sudo bash /opt/narmada/deploy/admin.sh create            # new admin (asks questions)
#   sudo bash /opt/narmada/deploy/admin.sh promote ram_bhakt # make an existing user admin
#   sudo bash /opt/narmada/deploy/admin.sh list              # list all accounts
#   sudo bash /opt/narmada/deploy/admin.sh password ram_bhakt
set -euo pipefail
APP_DIR=/opt/narmada; ENV_FILE=/etc/narmada.env
cmd="${1:-help}"; shift || true
run() { sudo -u narmada bash -c 'set -a; . "$0"; set +a; cd "$1"; shift; exec .venv/bin/flask --app app "$@"' "$ENV_FILE" "$APP_DIR" "$@"; }
case "$cmd" in
  create)   run create-admin "$@" ;;
  promote)  run make-admin "$@" ;;
  list)     run list-users ;;
  password) run reset-password "$@" ;;
  *) sed -n '2,6p' "$0" | sed 's/^# //' ;;
esac
