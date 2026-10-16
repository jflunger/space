#!/usr/bin/env bash
# run.sh contract (vibe starts this file; do not run it yourself):
#   - Run in the FOREGROUND. Never daemonize, never background with & or nohup.
#   - Listen on $PORT. vibe assigns it and passes it in the environment.
#   - Exit non-zero on failure, so vibe can see the crash and restart you.
# Output on stdout and stderr is appended to /var/lib/vibe/logs/space.log.
set -euo pipefail

PORT="${PORT:?vibe sets PORT; run this through vibe, not by hand}"

echo "space starting on port $PORT"


exec python3 "$(dirname "$0")/server.py"
