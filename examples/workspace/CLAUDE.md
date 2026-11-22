# Global instructions

Repos live under /codebase/<repo>. Commit and push work you want to keep: pods are disposable,
and only pushed refs can be summoned into another pod.

## Services

Databases, backend services and other dev services are not running when the pod starts.
Start only what the current task needs, when it needs it (for example `docker compose up -d db`
in the repo), and stop it when you're done (`docker compose stop`). Don't give containers a
restart policy (`restart: always` or `unless-stopped`): they'd come back on every pod start.
