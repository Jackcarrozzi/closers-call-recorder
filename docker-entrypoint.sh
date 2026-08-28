#!/bin/sh
set -e

# Railway (and most container hosts) have no way to hand you a file, only
# environment variables. If the rclone config arrives as one, write it out.
#
# Both branches below rebuild the file on EVERY boot rather than only when it
# doesn't exist yet. This runs against /data, a volume that survives across
# deploys - "only if missing" meant a rotated GDRIVE_TOKEN (or a corrected
# RCLONE_CONFIG_BASE64) was silently ignored forever after the first boot,
# because the file that first boot wrote was already sitting there. The
# environment is the source of truth every time this container starts.
#
# Rebuilding on every boot is also why none of this is allowed to be fatal.
# When it ran only once, a malformed value failed once and the volume kept the
# good file from the boot before; now the same malformed value is re-applied
# every single boot, and `set -e` would turn it into a container that never
# starts - which under Railway's restart policy means the recorder stops
# recording permanently over a bad upload credential. Recording is the job;
# uploading is not. So the config is built in a temp file and only moved into
# place once it is complete, and any failure downgrades to a warning that
# leaves whatever config was already there untouched.

# The Dockerfile sets this, but an empty override in the platform's UI would
# otherwise leave the redirections below writing to "" - which fails, and used
# to take the whole container down with it.
: "${RCLONE_CONFIG:=${DATA_DIR:-/data}/rclone.conf}"
export RCLONE_CONFIG

trim() {
  # Strips CR (a token pasted from Windows) and leading/trailing whitespace,
  # without touching anything in the middle of the value.
  printf '%s' "$1" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# Builds $RCLONE_CONFIG from the environment, and returns non-zero WITHOUT
# having touched the existing file if anything goes wrong. This is called from
# an `if`, which suspends `set -e` for everything inside it, so each step that
# matters checks its own exit status explicitly.
write_rclone_config() {
  tmp="${RCLONE_CONFIG}.new.$$"

  mkdir -p "$(dirname "$RCLONE_CONFIG")" || return 1

  if [ -n "$RCLONE_CONFIG_BASE64" ]; then
    if ! printf '%s' "$(trim "$RCLONE_CONFIG_BASE64")" | base64 -d > "$tmp" 2>/dev/null; then
      rm -f "$tmp"
      echo "WARNING: RCLONE_CONFIG_BASE64 is not valid base64." >&2
      return 1
    fi
    if [ ! -s "$tmp" ]; then
      rm -f "$tmp"
      echo "WARNING: RCLONE_CONFIG_BASE64 decoded to an empty file." >&2
      return 1
    fi
    mv "$tmp" "$RCLONE_CONFIG" || { rm -f "$tmp"; return 1; }
    chmod 600 "$RCLONE_CONFIG" 2>/dev/null || true
    echo "wrote rclone config to $RCLONE_CONFIG (rebuilt from RCLONE_CONFIG_BASE64)"
    return 0
  fi

  token=$(trim "$GDRIVE_TOKEN")

  # rclone's own token is one line of JSON starting {"access_token":... .
  # This isn't a hard gate - a real config problem shows up soon enough as an
  # upload failure - but a token that plainly isn't this shape is almost
  # always someone pasting the wrong thing, and worth saying so immediately
  # rather than after the first silent upload failure.
  case "$token" in
    '{"access_token"'*) ;;
    *)
      echo "WARNING: GDRIVE_TOKEN doesn't look like a single-line rclone token" >&2
      echo "  (expected it to start with {\"access_token\"...). Writing it anyway," >&2
      echo "  but uploads will likely fail. Re-copy the exact output of:" >&2
      echo "  rclone authorize \"drive\"" >&2
      ;;
  esac

  # Each optional line is a full `if` rather than `[ -n "$x" ] && echo ...`.
  # As the last line of the group, the latter makes the group's exit status 1
  # whenever that variable happens to be unset, which the caller would then
  # read as "the config could not be written" even though it was written fine.
  {
    echo "[gdrive]"
    echo "type = drive"
    echo "scope = drive"
    echo "token = $token"
    if [ -n "$GDRIVE_ROOT_FOLDER_ID" ]; then echo "root_folder_id = $(trim "$GDRIVE_ROOT_FOLDER_ID")"; fi
    if [ -n "$GDRIVE_CLIENT_ID" ]; then echo "client_id = $(trim "$GDRIVE_CLIENT_ID")"; fi
    if [ -n "$GDRIVE_CLIENT_SECRET" ]; then echo "client_secret = $(trim "$GDRIVE_CLIENT_SECRET")"; fi
  } > "$tmp" || { rm -f "$tmp"; return 1; }

  mv "$tmp" "$RCLONE_CONFIG" || { rm -f "$tmp"; return 1; }
  chmod 600 "$RCLONE_CONFIG" 2>/dev/null || true
  echo "built rclone config for Google Drive at $RCLONE_CONFIG (rebuilt from env, as always)"
  return 0
}

if [ -n "$RCLONE_CONFIG_BASE64" ] || [ -n "$GDRIVE_TOKEN" ]; then
  if write_rclone_config; then
    :
  else
    echo "WARNING: could not rebuild $RCLONE_CONFIG from the environment." >&2
    if [ -s "$RCLONE_CONFIG" ]; then
      echo "  Keeping the config already on the volume and carrying on." >&2
    else
      echo "  There is no usable config, so uploads will fail - but recording still" >&2
      echo "  works, and the backlog sweep sends everything up once this is fixed." >&2
    fi
  fi
fi

mkdir -p "${DATA_DIR:-/data}/sessions"
exec "$@"
