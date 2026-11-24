#!/usr/bin/env bash
# Install the Narmada Parikrama app on CentOS 7 with uv, gunicorn, nginx and systemd.
#
#   sudo DOMAIN=parikrama.example.com EMAIL=you@example.com bash deploy/centos7/install.sh
#
# DOMAIN / EMAIL are optional. With them, a free HTTPS certificate is set up
# (needed for GPS on phones). Without them the site runs on plain http://SERVER-IP.
# Safe to run again: it updates the code and keeps the database, uploads and secret key.
set -euo pipefail

APP_USER=narmada
APP_DIR=/opt/narmada
DATA_DIR=/var/lib/narmada            # database + uploaded photos/videos (back this up!)
ENV_FILE=/etc/narmada.env
REPO=https://github.com/3dworldfreenow/Narmada_Parikrama.git
PYTHON_VERSION=3.12
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)."; exit 1; }
grep -q 'release 7' /etc/redhat-release 2>/dev/null || echo "Warning: this script is written for CentOS 7."

# ---------------------------------------------------------------- 1. yum repos
# CentOS 7 is end-of-life: its mirrors moved to vault.centos.org.
if ! yum -q makecache fast >/dev/null 2>&1; then
  say "Pointing yum at vault.centos.org (CentOS 7 is end-of-life)"
  sed -i -e 's|^mirrorlist=|#mirrorlist=|' \
         -e 's|^#\?baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' \
         /etc/yum.repos.d/CentOS-*.repo
  yum clean all -q
fi

say "Installing system packages"
yum install -y -q git curl tar sqlite sudo policycoreutils-python

# nginx from nginx.org (CentOS 7's own repos don't include it)
if ! command -v nginx >/dev/null; then
  cat > /etc/yum.repos.d/nginx.repo <<'EOF'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/7/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
EOF
  yum install -y -q nginx
fi

# ---------------------------------------------------------------- 2. user + uv
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR/uploads"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

if ! command -v uv >/dev/null && [ ! -x /usr/local/bin/uv ]; then
  say "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi
UV=/usr/local/bin/uv; [ -x "$UV" ] || UV="$(command -v uv)"
"$UV" --version

# ---------------------------------------------------------------- 3. code + Python
say "Getting the code into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  (cd "$APP_DIR" && git pull --ff-only)
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Installing Python $PYTHON_VERSION and dependencies with uv"
# uv's Python builds need only glibc 2.17, which CentOS 7 has.
sudo -u "$APP_USER" env HOME=/home/$APP_USER UV_PYTHON_INSTALL_DIR=/home/$APP_USER/.uv-python \
  "$UV" python install "$PYTHON_VERSION"
sudo -u "$APP_USER" env HOME=/home/$APP_USER UV_PYTHON_INSTALL_DIR=/home/$APP_USER/.uv-python \
  bash -c "cd '$APP_DIR' && '$UV' sync --python '$PYTHON_VERSION' --no-dev"

# ---------------------------------------------------------------- 4. settings
if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE (secret key, paths)"
  cat > "$ENV_FILE" <<EOF
SECRET_KEY=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n')
DATABASE_PATH=$DATA_DIR/narmada.db
UPLOAD_DIR=$DATA_DIR/uploads
BEHIND_PROXY=1
HTTPS=0
# ADMIN_EMAILS=you@example.com
# GPS_RADIUS_KM=3
EOF
  chmod 600 "$ENV_FILE"
fi

say "Creating the database (first run only)"
bash "$APP_DIR/deploy/centos7/flask-cmd.sh" init-db
bash "$APP_DIR/deploy/centos7/flask-cmd.sh" apply-locations

# ---------------------------------------------------------------- 5. systemd
say "Setting up the systemd service"
install -m 644 "$APP_DIR/deploy/centos7/narmada.service" /etc/systemd/system/narmada.service
systemctl daemon-reload
systemctl enable narmada >/dev/null
systemctl restart narmada

# ---------------------------------------------------------------- 6. web server
# If Apache already serves other websites on this machine, add the site to
# Apache instead of starting nginx (both can't use port 80).
if systemctl is-active --quiet httpd; then
  say "Apache is already running here – adding the site to Apache instead of nginx"
  if [ -n "$DOMAIN" ]; then
    DOMAIN="$DOMAIN" EMAIL="$EMAIL" bash "$APP_DIR/deploy/centos7/setup-apache.sh"
  else
    echo "Run: DOMAIN=your.domain EMAIL=you@example.com bash $APP_DIR/deploy/centos7/setup-apache.sh"
  fi
  exit 0
fi
say "Configuring nginx"
SERVER_NAME="${DOMAIN:-_}"
sed "s|__SERVER_NAME__|$SERVER_NAME|g; s|__APP_DIR__|$APP_DIR|g" \
  "$APP_DIR/deploy/centos7/nginx-narmada.conf" > /etc/nginx/conf.d/narmada.conf
rm -f /etc/nginx/conf.d/default.conf
mkdir -p /var/www/acme
# SELinux: let nginx talk to gunicorn and read the static files
if command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ]; then
  setsebool -P httpd_can_network_connect 1
  chcon -R -t httpd_sys_content_t "$APP_DIR/static" /var/www/acme || true
fi
nginx -t
systemctl enable nginx >/dev/null
systemctl restart nginx

if systemctl is-active --quiet firewalld; then
  firewall-cmd -q --permanent --add-service=http --add-service=https
  firewall-cmd -q --reload
fi

# ---------------------------------------------------------------- 7. HTTPS (optional)
if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  say "Getting a free HTTPS certificate for $DOMAIN (acme.sh + Let's Encrypt)"
  [ -d /root/.acme.sh ] || curl -s https://get.acme.sh | sh -s email="$EMAIL"
  /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
  /root/.acme.sh/acme.sh --issue -d "$DOMAIN" -w /var/www/acme --keylength ec-256 || true
  mkdir -p /etc/nginx/ssl
  /root/.acme.sh/acme.sh --install-cert -d "$DOMAIN" --ecc \
    --key-file /etc/nginx/ssl/narmada.key --fullchain-file /etc/nginx/ssl/narmada.crt \
    --reloadcmd "systemctl reload nginx"
  sed "s|__SERVER_NAME__|$DOMAIN|g; s|__APP_DIR__|$APP_DIR|g" \
    "$APP_DIR/deploy/centos7/nginx-narmada-https.conf" > /etc/nginx/conf.d/narmada.conf
  sed -i 's/^HTTPS=0/HTTPS=1/' "$ENV_FILE"
  nginx -t && systemctl reload nginx && systemctl restart narmada
fi

say "Done!"
systemctl --no-pager --lines=3 status narmada || true
if [ -n "$DOMAIN" ]; then
  echo "Open https://$DOMAIN and create the first account – it becomes the admin."
else
  echo "Open http://$(hostname -I | awk '{print $1}') and create the first account – it becomes the admin."
  echo "Note: phones only allow GPS on https:// sites. Re-run with DOMAIN=... EMAIL=... to add HTTPS."
fi
