#!/usr/bin/env bash
# Serve the Narmada app through an EXISTING Apache (httpd) instead of nginx.
# Use this when Apache already owns ports 80/443 for other websites.
# It only adds one virtual host for DOMAIN; other sites are not touched.
#
#   DOMAIN=narmada.opirsys.com EMAIL=you@example.com bash deploy/centos7/setup-apache.sh
#
# Run it once before DNS is ready (HTTP only), and again after DNS points here
# to add HTTPS. Safe to run again.
set -euo pipefail
DOMAIN="${DOMAIN:?Set DOMAIN=your.domain}"
EMAIL="${EMAIL:-}"
APP_DIR=/opt/narmada
ENV_FILE=/etc/narmada.env
WEBROOT=/var/www/acme
CONF=/etc/httpd/conf.d/narmada.conf
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root."; exit 1; }

say "Stopping the unused nginx (Apache serves the site)"
systemctl disable --now nginx >/dev/null 2>&1 || true

say "Checking Apache modules"
for m in proxy_module proxy_http_module headers_module; do
  httpd -M 2>/dev/null | grep -q "$m" || { echo "Apache module $m is not loaded – please enable it."; exit 1; }
done
HAS_SSL=0; httpd -M 2>/dev/null | grep -q ssl_module && HAS_SSL=1
HAS_REWRITE=0; httpd -M 2>/dev/null | grep -q rewrite_module && HAS_REWRITE=1

mkdir -p "$WEBROOT/.well-known/acme-challenge"
if command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ]; then
  setsebool -P httpd_can_network_connect 1
  chcon -R -t httpd_sys_content_t "$APP_DIR/static" "$WEBROOT" || true
fi

write_http() {
cat > "$CONF" <<EOF
# Narmada Parikrama guide – $DOMAIN (written by deploy/centos7/setup-apache.sh)
<VirtualHost *:80>
    ServerName $DOMAIN
    LimitRequestBody 136314880
    Alias /.well-known/acme-challenge/ $WEBROOT/.well-known/acme-challenge/
    <Directory $WEBROOT>
        Require all granted
    </Directory>
    Alias /static/ $APP_DIR/static/
    <Directory $APP_DIR/static>
        Require all granted
    </Directory>
    ProxyPreserveHost On
    ProxyTimeout 300
    ProxyPass /.well-known/ !
    ProxyPass /static/ !
    ProxyPass / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/
    RequestHeader set X-Forwarded-Proto "http"
    $1
</VirtualHost>
EOF
}

say "Adding the HTTP site for $DOMAIN"
write_http ""
apachectl configtest
apachectl graceful          # reloads without dropping other sites' visitors

# ---------------------------------------------------------------- HTTPS
if [ -z "$EMAIL" ]; then
  echo "No EMAIL given – HTTP only. Re-run with EMAIL=... once DNS points here to add HTTPS."
  exit 0
fi
if ! getent hosts "$DOMAIN" >/dev/null; then
  echo "$DOMAIN does not resolve yet. Add the DNS A record, wait a few minutes, then run this again."
  exit 0
fi
if [ "$HAS_SSL" != 1 ]; then
  say "Installing mod_ssl"
  yum install -y -q mod_ssl
fi

say "Getting a free certificate for $DOMAIN (acme.sh + Let's Encrypt)"
[ -d /root/.acme.sh ] || curl -s https://get.acme.sh | sh -s email="$EMAIL"
/root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
/root/.acme.sh/acme.sh --issue -d "$DOMAIN" -w "$WEBROOT" --keylength 2048 || true
mkdir -p /etc/httpd/ssl
/root/.acme.sh/acme.sh --install-cert -d "$DOMAIN" \
  --cert-file /etc/httpd/ssl/narmada.crt --key-file /etc/httpd/ssl/narmada.key \
  --fullchain-file /etc/httpd/ssl/narmada.fullchain.crt \
  --reloadcmd "apachectl graceful"

say "Adding the HTTPS site and redirecting http → https"
if [ "$HAS_REWRITE" = 1 ]; then
  write_http 'RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\.well-known/
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]'
else
  write_http ""
fi
cat >> "$CONF" <<EOF

<VirtualHost *:443>
    ServerName $DOMAIN
    SSLEngine on
    SSLCertificateFile /etc/httpd/ssl/narmada.crt
    SSLCertificateKeyFile /etc/httpd/ssl/narmada.key
    SSLCertificateChainFile /etc/httpd/ssl/narmada.fullchain.crt
    LimitRequestBody 136314880
    Alias /static/ $APP_DIR/static/
    <Directory $APP_DIR/static>
        Require all granted
    </Directory>
    ProxyPreserveHost On
    ProxyTimeout 300
    ProxyPass /static/ !
    ProxyPass / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
EOF
apachectl configtest
apachectl graceful
sed -i 's/^HTTPS=0/HTTPS=1/' "$ENV_FILE" && systemctl restart narmada
say "Done: https://$DOMAIN"
