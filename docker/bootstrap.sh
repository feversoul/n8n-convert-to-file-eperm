#!/bin/sh
# Entrypoint of the n8n container in docker-compose.yml.
# First start only: import the stand-in Telegram credential and the lab
# workflows, and publish them. Later starts leave your edits alone.
set -eu

MARK=/home/node/.n8n/.eperm-lab-imported

if [ ! -f "$MARK" ]; then
  STAGE=$(mktemp -d)
  node /bootstrap/prepare.mjs "$STAGE" /bootstrap/workflows
  n8n import:credentials --input="$STAGE/credentials.json"
  n8n import:workflow --separate --input="$STAGE/workflows"
  # One CLI call per workflow; this is most of the first start.
  for file in "$STAGE"/workflows/*.json; do
    n8n publish:workflow --id="$(basename "$file" .json)"
  done
  rm -rf "$STAGE"
  touch "$MARK"
  echo "eperm-lab: workflows imported and published"
fi

exec n8n start
