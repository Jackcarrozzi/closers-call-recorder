#!/usr/bin/env bash
# Installs the Closers call recorder as a system service on Ubuntu 22.04/24.04.
# Works on both ARM (Oracle Ampere) and x86. Run it from inside the cloned repo:
#
#   sudo bash install.sh
#
set -euo pipefail

APP_DIR=/opt/closers-recorder
DATA_DIR=/var/lib/closers-recorder
SVC_USER=closersrec
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash install.sh" >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|arm64) RCLONE_ARCH=arm64 ;;
  x86_64|amd64)  RCLONE_ARCH=amd64 ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac
echo "==> Architecture: $(uname -m) (rclone $RCLONE_ARCH)"

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl unzip git ffmpeg python3 make g++ >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

if ! command -v rclone >/dev/null; then
  echo "==> Installing rclone"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/rclone.zip" "https://downloads.rclone.org/rclone-current-linux-${RCLONE_ARCH}.zip"
  unzip -q "$tmp/rclone.zip" -d "$tmp"
  install -m 755 "$tmp"/rclone-*/rclone /usr/local/bin/rclone
  rm -rf "$tmp"
fi
echo "    $(rclone version | head -1)"

echo "==> Creating service account and directories"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$DATA_DIR/sessions"

echo "==> Copying application files"
install -m 644 "$SRC_DIR"/*.js "$APP_DIR"/
install -m 644 "$SRC_DIR"/package.json "$APP_DIR"/
[[ -f "$SRC_DIR/package-lock.json" ]] && install -m 644 "$SRC_DIR/package-lock.json" "$APP_DIR"/

echo "==> Installing dependencies (this compiles the audio libraries, give it a minute)"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> Writing a starter .env (you still need to fill it in)"
  install -m 600 "$SRC_DIR/.env.example" "$APP_DIR/.env"
fi

chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "$DATA_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> Registering the service"
cat > /etc/systemd/system/closers-recorder.service <<UNIT
[Unit]
Description=Closers call recorder
Documentation=https://github.com/Jackcarrozzi/closers-call-recorder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
Environment=DATA_DIR=$DATA_DIR
Environment=HOME=$DATA_DIR
ExecStart=/usr/bin/node $APP_DIR/index.js
Restart=always
RestartSec=10
# Finish and save whatever call is in progress before dying.
KillSignal=SIGTERM
TimeoutStopSec=300

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable closers-recorder >/dev/null 2>&1

cat <<DONE

────────────────────────────────────────────────────────────
 Installed. Three things left:

 1. Fill in your settings:
      sudo nano $APP_DIR/.env

 2. Authorise Google Drive (creates the token it needs):
      sudo -u $SVC_USER HOME=$DATA_DIR rclone config

 3. Start it:
      sudo systemctl start closers-recorder
      sudo journalctl -u closers-recorder -f

 To print every channel ID the bot can see, once the token is set:
      sudo -u $SVC_USER HOME=$DATA_DIR \\
        env \$(grep -v '^#' $APP_DIR/.env | xargs) \\
        node $APP_DIR/list-channels.js
────────────────────────────────────────────────────────────
DONE
