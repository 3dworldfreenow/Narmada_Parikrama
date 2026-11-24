#!/usr/bin/env bash
# Pull the latest code and restart. Database and uploads are not touched.
#   sudo bash /opt/narmada/deploy/centos7/update.sh
set -euo pipefail
cd /opt/narmada
sudo -u narmada git pull --ff-only
sudo -u narmada env HOME=/home/narmada UV_PYTHON_INSTALL_DIR=/home/narmada/.uv-python /usr/local/bin/uv sync --no-dev
sudo -u narmada bash -c "set -a; . /etc/narmada.env; set +a; .venv/bin/flask --app app apply-locations"
systemctl restart narmada
echo "Updated and restarted."
