#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${DATABASE_URL:-}" || -n "${SILO_REGRESSION_DATABASE_URL:-}" ]]; then
  echo 'Unset database connection overrides before starting the disposable regression database.' >&2
  exit 1
fi

if [[ -n "${DOCKER_HOST:-}" ]]; then
  echo 'Unset the Docker host override before starting the disposable regression database.' >&2
  exit 1
fi
context="$(docker context show)"
endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')"
if [[ "$endpoint" != unix:///* ]]; then
  echo 'A local Docker socket is required for the disposable regression database.' >&2
  exit 1
fi
docker_local=(docker --context "$context")

suffix="$(bun --no-env-file -e 'console.log(crypto.randomUUID().replaceAll("-", ""))')"
name="silo_regression_$suffix"
host="$(bun --no-env-file -e '
  import { networkInterfaces } from "node:os";
  const address = Object.values(networkInterfaces()).flat()
    .find(entry => entry?.internal && entry.family === "IPv4");
  if (!address) throw new Error("IPv4 loopback interface is required");
  console.log(address.address);
')"
image='pgvector/pgvector@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b'
container="$("${docker_local[@]}" run --rm --detach --name "$name" --publish "$host::5432" \
  --env "POSTGRES_DB=$name" --env "POSTGRES_PASSWORD=$suffix" "$image")"
trap '"${docker_local[@]}" stop --time 5 "$container" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=
for attempt in {1..45}; do
  if "${docker_local[@]}" exec "$container" pg_isready -h "$host" -U postgres -d "$name" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1
published="$("${docker_local[@]}" port "$container" 5432/tcp)"
if [[ "$published" != "$host:"* || ! "${published##*:}" =~ ^[0-9]+$ ]]; then
  echo 'Disposable regression database is not mapped to the expected address.' >&2
  exit 1
fi
url="postgresql://postgres:$suffix@$published/$name"
env -i PATH="$PATH" MIGRATE_ENV_FILE=/dev/null DATABASE_URL="$url"   bash scripts/migrate.sh --target local
SILO_REGRESSION_DATABASE_URL="$url" bun --no-env-file scripts/test-regression-postgres.ts
