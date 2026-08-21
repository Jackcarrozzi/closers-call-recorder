#!/bin/sh
set -e

# Railway (and most container hosts) have no way to hand you a file, only
# environment variables. If the rclone config arrives as one, write it out.
if [ -n "$RCLONE_CONFIG_BASE64" ] && [ ! -s "$RCLONE_CONFIG" ]; then
  mkdir -p "$(dirname "$RCLONE_CONFIG")"
  echo "$RCLONE_CONFIG_BASE64" | base64 -d > "$RCLONE_CONFIG"
  chmod 600 "$RCLONE_CONFIG"
  echo "wrote rclone config to $RCLONE_CONFIG"
elif [ -n "$GDRIVE_TOKEN" ] && [ ! -s "$RCLONE_CONFIG" ]; then
  mkdir -p "$(dirname "$RCLONE_CONFIG")"
  {
    echo "[gdrive]"
    echo "type = drive"
    echo "scope = drive"
    echo "token = $GDRIVE_TOKEN"
    [ -n "$GDRIVE_ROOT_FOLDER_ID" ] && echo "root_folder_id = $GDRIVE_ROOT_FOLDER_ID"
    [ -n "$GDRIVE_CLIENT_ID" ] && echo "client_id = $GDRIVE_CLIENT_ID"
    [ -n "$GDRIVE_CLIENT_SECRET" ] && echo "client_secret = $GDRIVE_CLIENT_SECRET"
  } > "$RCLONE_CONFIG"
  chmod 600 "$RCLONE_CONFIG"
  echo "built rclone config for Google Drive at $RCLONE_CONFIG"
fi

mkdir -p "${DATA_DIR:-/data}/sessions"
exec "$@"
