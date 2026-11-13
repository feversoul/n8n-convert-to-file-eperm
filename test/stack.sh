#!/bin/sh
# test/stack.sh up|down|logs [config]   the test stack by hand
#   config: filesystem (default), memory, database, readonly, restricted
cd "$(dirname "$0")/.."
action=$1
config=${2:-filesystem}
files="-f docker-compose.yml -f test/docker-compose.yml -f test/configs/$config.yml"
case "$action" in
  up) docker compose --env-file test/test.env $files -p eperm-test up -d ;;
  down) docker compose --env-file test/test.env $files -f test/configs/readonly.yml -p eperm-test down -v ;;
  logs) docker compose --env-file test/test.env $files -p eperm-test logs --tail "${TAIL:-40}" n8n ;;
esac
