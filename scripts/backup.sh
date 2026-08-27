#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=backup-lib.sh
source "$SCRIPT_DIRECTORY/backup-lib.sh"

backup_load_environment
backup_validate_common
backup_prepare_work_directory

backup_require_command docker
backup_require_command aws
backup_require_command flock
backup_require_command sha256sum
backup_require_command find
backup_require_command sort
backup_require_command xargs

for variable in BACKUP_COMPOSE_FILE BACKUP_POSTGRES_SERVICE POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD \
  OBJECT_STORAGE_ENDPOINT OBJECT_STORAGE_BUCKET OBJECT_STORAGE_ACCESS_KEY_ID OBJECT_STORAGE_SECRET_ACCESS_KEY; do
  backup_require_variable "$variable"
done

[[ "$BACKUP_COMPOSE_FILE" == /* && -f "$BACKUP_COMPOSE_FILE" && ! -L "$BACKUP_COMPOSE_FILE" ]] \
  || backup_die "BACKUP_COMPOSE_FILE must be an existing absolute, non-symlink file"
[[ "$BACKUP_POSTGRES_SERVICE" =~ ^[a-zA-Z0-9._-]{1,80}$ ]] || backup_die "invalid BACKUP_POSTGRES_SERVICE"
[[ "$POSTGRES_DB" =~ ^[a-zA-Z0-9._-]{1,128}$ ]] || backup_die "invalid POSTGRES_DB"
[[ "$POSTGRES_USER" =~ ^[a-zA-Z0-9._-]{1,128}$ ]] || backup_die "invalid POSTGRES_USER"
[[ "$POSTGRES_PASSWORD" != *$'\n'* ]] || backup_die "POSTGRES_PASSWORD contains a newline"
[[ "$OBJECT_STORAGE_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || backup_die "invalid OBJECT_STORAGE_BUCKET"
[[ "$OBJECT_STORAGE_ACCESS_KEY_ID" != *$'\n'* && "$OBJECT_STORAGE_SECRET_ACCESS_KEY" != *$'\n'* ]] \
  || backup_die "object storage credentials contain a newline"

case "$OBJECT_STORAGE_ENDPOINT" in
  https://*) ;;
  http://*) [[ "${OBJECT_STORAGE_ALLOW_INSECURE_HTTP:-}" == "true" ]] \
    || backup_die "HTTP object storage requires OBJECT_STORAGE_ALLOW_INSECURE_HTTP=true" ;;
  *) backup_die "OBJECT_STORAGE_ENDPOINT must be an HTTP(S) URL" ;;
esac
[[ "$RESTIC_REPOSITORY" != "s3:${OBJECT_STORAGE_ENDPOINT}"* ]] \
  || backup_die "primary object storage and restic repository use the same endpoint; this is not off-site"

LOCK_FILE="$BACKUP_WORK_DIR/backup.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || backup_die "another ASCN backup is already running"

STAGING_DIRECTORY="$(mktemp -d "$BACKUP_WORK_DIR/backup.XXXXXXXX")"
PAYLOAD_DIRECTORY="$STAGING_DIRECTORY/payload"
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  rm -rf -- "$STAGING_DIRECTORY"
  if (( exit_code != 0 )); then backup_log "backup run failed; inspect this unit's log"; fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
install -d -m 0700 "$PAYLOAD_DIRECTORY/object-storage" "$PAYLOAD_DIRECTORY/legacy-recordings" "$PAYLOAD_DIRECTORY/recording-spool"

backup_log "checking encrypted off-site repository"
restic_run snapshots --host "$BACKUP_SOURCE_ID" --tag ascn-daily >/dev/null \
  || backup_die "restic repository is unavailable or not initialized (refusing to continue)"

backup_log "creating a transaction-consistent PostgreSQL custom dump"
PGPASSWORD="$POSTGRES_PASSWORD" docker compose -f "$BACKUP_COMPOSE_FILE" exec -T -e PGPASSWORD "$BACKUP_POSTGRES_SERVICE" \
  pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >"$PAYLOAD_DIRECTORY/postgres.dump"
[[ -s "$PAYLOAD_DIRECTORY/postgres.dump" ]] || backup_die "pg_dump produced an empty file"

OBJECT_PREFIX="${OBJECT_STORAGE_BACKUP_PREFIX:-recordings/}"
OBJECT_PREFIX="${OBJECT_PREFIX#/}"
[[ "$OBJECT_PREFIX" == "recordings/" ]] \
  || backup_die "OBJECT_STORAGE_BACKUP_PREFIX must be recordings/ so DB-to-object restore checks remain deterministic"
SOURCE_URI="s3://$OBJECT_STORAGE_BUCKET"
if [[ -n "$OBJECT_PREFIX" ]]; then SOURCE_URI="$SOURCE_URI/$OBJECT_PREFIX"; fi

backup_log "exporting object storage through the S3 API"
AWS_ARGUMENTS=(
  --endpoint-url "$OBJECT_STORAGE_ENDPOINT"
  --cli-connect-timeout 15
  --cli-read-timeout 300
)
if [[ -n "${OBJECT_STORAGE_CA_BUNDLE:-}" ]]; then
  [[ "$OBJECT_STORAGE_CA_BUNDLE" == /* && -f "$OBJECT_STORAGE_CA_BUNDLE" && ! -L "$OBJECT_STORAGE_CA_BUNDLE" ]] \
    || backup_die "OBJECT_STORAGE_CA_BUNDLE must be an absolute, regular, non-symlink file"
  AWS_ARGUMENTS+=(--ca-bundle "$OBJECT_STORAGE_CA_BUNDLE")
fi
AWS_ACCESS_KEY_ID="$OBJECT_STORAGE_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$OBJECT_STORAGE_SECRET_ACCESS_KEY" \
AWS_SESSION_TOKEN="${OBJECT_STORAGE_SESSION_TOKEN:-}" \
AWS_DEFAULT_REGION="${OBJECT_STORAGE_REGION:-us-east-1}" \
AWS_EC2_METADATA_DISABLED=true \
  aws "${AWS_ARGUMENTS[@]}" \
  s3 sync "$SOURCE_URI" "$PAYLOAD_DIRECTORY/object-storage" \
  --only-show-errors --no-progress
if find "$STAGING_DIRECTORY" -type l -print -quit | grep -q .; then
  backup_die "object export unexpectedly created a symbolic link"
fi

OBJECT_COUNT="$(find "$PAYLOAD_DIRECTORY/object-storage" -type f -print0 | awk 'BEGIN { RS="\0" } END { print NR }')"

# Transitional protection for recordings created before object storage was
# enabled. They stay portable in the snapshot until the one-time migration is
# complete; new recordings never use this path.
LEGACY_SERVICE="${BACKUP_LEGACY_RECORDINGS_SERVICE:-app}"
LEGACY_PATH="${BACKUP_LEGACY_RECORDINGS_PATH:-/app/legacy-data/recordings}"
[[ "$LEGACY_SERVICE" =~ ^[a-zA-Z0-9._-]{1,80}$ ]] || backup_die "invalid BACKUP_LEGACY_RECORDINGS_SERVICE"
[[ "$LEGACY_PATH" =~ ^/[a-zA-Z0-9._/-]+$ && "$LEGACY_PATH" != *".."* ]] \
  || backup_die "invalid BACKUP_LEGACY_RECORDINGS_PATH"
if docker compose -f "$BACKUP_COMPOSE_FILE" exec -T "$LEGACY_SERVICE" test -d "$LEGACY_PATH"; then
  backup_log "copying transitional legacy recordings"
  docker compose -f "$BACKUP_COMPOSE_FILE" cp \
    "$LEGACY_SERVICE:$LEGACY_PATH/." "$PAYLOAD_DIRECTORY/legacy-recordings/"
fi
LEGACY_OBJECT_COUNT="$(find "$PAYLOAD_DIRECTORY/legacy-recordings" -type f -print0 | awk 'BEGIN { RS="\0" } END { print NR }')"

# The durable gateway spool contains recordings that have not completed the
# S3 -> database acknowledgement transaction yet. It is backed up as recovery
# state, including .part files, rather than treated as an object-store copy.
SPOOL_SERVICE="${BACKUP_RECORDING_SPOOL_SERVICE:-voice-gateway}"
SPOOL_PATH="${BACKUP_RECORDING_SPOOL_PATH:-/recording-spool}"
[[ "$SPOOL_SERVICE" =~ ^[a-zA-Z0-9._-]{1,80}$ ]] || backup_die "invalid BACKUP_RECORDING_SPOOL_SERVICE"
[[ "$SPOOL_PATH" =~ ^/[a-zA-Z0-9._/-]+$ && "$SPOOL_PATH" != *".."* ]] \
  || backup_die "invalid BACKUP_RECORDING_SPOOL_PATH"
docker compose -f "$BACKUP_COMPOSE_FILE" exec -T "$SPOOL_SERVICE" test -d "$SPOOL_PATH" \
  || backup_die "durable recording spool is unavailable"
backup_log "copying uncommitted recording spool"
docker compose -f "$BACKUP_COMPOSE_FILE" cp \
  "$SPOOL_SERVICE:$SPOOL_PATH/." "$PAYLOAD_DIRECTORY/recording-spool/"
SPOOL_OBJECT_COUNT="$(find "$PAYLOAD_DIRECTORY/recording-spool" -type f -print0 | awk 'BEGIN { RS="\0" } END { print NR }')"
if find "$STAGING_DIRECTORY" -type l -print -quit | grep -q .; then
  backup_die "backup payload unexpectedly contains a symbolic link"
fi
{
  printf 'format=ascn-backup-v1\n'
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'source_id=%s\n' "$BACKUP_SOURCE_ID"
  printf 'database=%s\n' "$POSTGRES_DB"
  printf 'object_bucket=%s\n' "$OBJECT_STORAGE_BUCKET"
  printf 'object_prefix=%s\n' "$OBJECT_PREFIX"
  printf 'object_count=%s\n' "$OBJECT_COUNT"
  printf 'legacy_recording_count=%s\n' "$LEGACY_OBJECT_COUNT"
  printf 'recording_spool_file_count=%s\n' "$SPOOL_OBJECT_COUNT"
} >"$PAYLOAD_DIRECTORY/METADATA"

backup_log "hashing the portable backup payload"
(
  cd "$PAYLOAD_DIRECTORY"
  find . -type f ! -path './SHA256SUMS' -print0 \
    | sort -z \
    | xargs -0 -r sha256sum >SHA256SUMS
)
[[ -s "$PAYLOAD_DIRECTORY/SHA256SUMS" ]] || backup_die "payload checksum manifest is empty"

backup_log "writing encrypted, deduplicated restic snapshot"
restic_run backup "$PAYLOAD_DIRECTORY" \
  --host "$BACKUP_SOURCE_ID" \
  --tag ascn-daily \
  --tag "format-v1"
backup_log "applying retention policy"
FORGET_ARGUMENTS=(
  forget --host "$BACKUP_SOURCE_ID" --tag ascn-daily
  --group-by host,tags
  --keep-daily "${BACKUP_KEEP_DAILY:-7}"
  --keep-weekly "${BACKUP_KEEP_WEEKLY:-5}"
  --keep-monthly "${BACKUP_KEEP_MONTHLY:-12}"
)
if [[ "${BACKUP_PRUNE_AFTER_FORGET:-false}" == "true" ]]; then FORGET_ARGUMENTS+=(--prune); fi
restic_run "${FORGET_ARGUMENTS[@]}"

if [[ "${BACKUP_RESTIC_CHECK_SUBSET:-5%}" != "off" ]]; then
  backup_log "checking a repository data subset"
  restic_run check --read-data-subset="${BACKUP_RESTIC_CHECK_SUBSET:-5%}"
fi

backup_log "backup completed successfully ($OBJECT_COUNT objects, $LEGACY_OBJECT_COUNT legacy recordings, $SPOOL_OBJECT_COUNT spool files)"
