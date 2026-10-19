#!/bin/sh
# Runs the command as the unprivileged `node` user. When started as root (the default), first make
# sure the data directory (often a fresh bind mount owned by root) is writable by that user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${SMALTIC_DATA_DIR:-/data}"
  chown node:node "${SMALTIC_DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
