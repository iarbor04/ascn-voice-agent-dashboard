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
backup_require_command flock
backup_require_command sha256sum
backup_require_command openssl
backup_require_command find
backup_require_variable BACKUP_RESTORE_POSTGRES_IMAGE

[[ "$BACKUP_RESTORE_POSTGRES_IMAGE" != *$'\n'* ]] || backup_die "invalid BACKUP_RESTORE_POSTGRES_IMAGE"
docker image inspect "$BACKUP_RESTORE_POSTGRES_IMAGE" >/dev/null \
  || backup_die "restore image is not present locally; pull and pin it during maintenance: $BACKUP_RESTORE_POSTGRES_IMAGE"
REQUIRED_TABLE="${BACKUP_RESTORE_REQUIRED_TABLE:-ascn_schema_migrations}"
[[ "$REQUIRED_TABLE" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || backup_die "invalid BACKUP_RESTORE_REQUIRED_TABLE"

LOCK_FILE="$BACKUP_WORK_DIR/restore-test.lock"
exec 8>"$LOCK_FILE"
flock -n 8 || backup_die "another ASCN restore test is already running"

RESTORE_DIRECTORY="$(mktemp -d "$BACKUP_WORK_DIR/restore.XXXXXXXX")"
CONTAINER_NAME="ascn-restore-${BACKUP_SOURCE_ID//[^a-zA-Z0-9_.-]/-}-$$"
CONTAINER_STARTED=false
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  if [[ "$CONTAINER_STARTED" == "true" ]]; then docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; fi
  rm -rf -- "$RESTORE_DIRECTORY"
  if (( exit_code != 0 )); then backup_log "restore validation failed"; fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

backup_log "restoring the latest encrypted snapshot into an isolated directory"
restic_run restore latest --host "$BACKUP_SOURCE_ID" --tag ascn-daily --target "$RESTORE_DIRECTORY"

mapfile -d '' MANIFESTS < <(find "$RESTORE_DIRECTORY" -type f -name SHA256SUMS ! -path '*/object-storage/*' -print0)
(( ${#MANIFESTS[@]} == 1 )) || backup_die "expected one checksum manifest, found ${#MANIFESTS[@]}"
PAYLOAD_DIRECTORY="$(dirname -- "${MANIFESTS[0]}")"
[[ -f "$PAYLOAD_DIRECTORY/METADATA" && -f "$PAYLOAD_DIRECTORY/postgres.dump" ]] \
  || backup_die "restored snapshot does not contain the v1 payload"
grep -qx 'format=ascn-backup-v1' "$PAYLOAD_DIRECTORY/METADATA" || backup_die "unsupported backup format"

backup_log "verifying every restored byte against SHA-256 manifest"
(
  cd "$PAYLOAD_DIRECTORY"
  sha256sum --check --strict SHA256SUMS
)
docker run --rm --network none \
  --volume "$PAYLOAD_DIRECTORY:/payload:ro" \
  "$BACKUP_RESTORE_POSTGRES_IMAGE" \
  pg_restore --list /payload/postgres.dump >/dev/null \
  || backup_die "PostgreSQL archive directory is corrupt"

EXPECTED_OBJECTS="$(awk -F= '$1 == "object_count" { print $2 }' "$PAYLOAD_DIRECTORY/METADATA")"
[[ "$EXPECTED_OBJECTS" =~ ^[0-9]+$ ]] || backup_die "invalid object_count in metadata"
ACTUAL_OBJECTS="$(find "$PAYLOAD_DIRECTORY/object-storage" -type f -print0 | awk 'BEGIN { RS="\0" } END { print NR }')"
[[ "$ACTUAL_OBJECTS" == "$EXPECTED_OBJECTS" ]] \
  || backup_die "object count mismatch: expected $EXPECTED_OBJECTS, restored $ACTUAL_OBJECTS"

while IFS= read -r -d '' wav; do
  [[ "$(stat -c '%s' "$wav")" -ge 44 ]] || backup_die "truncated WAV in restored objects"
  [[ "$(dd if="$wav" bs=1 count=4 status=none)" == "RIFF" ]] || backup_die "invalid RIFF header in restored objects"
  [[ "$(dd if="$wav" bs=1 skip=8 count=4 status=none)" == "WAVE" ]] || backup_die "invalid WAVE header in restored objects"
done < <(find "$PAYLOAD_DIRECTORY/object-storage" "$PAYLOAD_DIRECTORY/legacy-recordings" -type f -name '*.wav' -print0)

backup_log "starting disposable PostgreSQL for a real logical restore"
RESTORE_PASSWORD="$(openssl rand -hex 24)"
docker run --detach --rm --name "$CONTAINER_NAME" --network none \
  --env POSTGRES_PASSWORD="$RESTORE_PASSWORD" \
  --env POSTGRES_DB=ascn_restore \
  "$BACKUP_RESTORE_POSTGRES_IMAGE" >/dev/null
CONTAINER_STARTED=true

READY=false
for _ in {1..90}; do
  if docker exec --env PGPASSWORD="$RESTORE_PASSWORD" "$CONTAINER_NAME" \
    pg_isready --quiet --username postgres --dbname ascn_restore; then
    READY=true
    break
  fi
  sleep 1
done
[[ "$READY" == "true" ]] || backup_die "disposable PostgreSQL did not become ready"

docker cp "$PAYLOAD_DIRECTORY/postgres.dump" "$CONTAINER_NAME:/tmp/ascn.dump"
docker exec --env PGPASSWORD="$RESTORE_PASSWORD" "$CONTAINER_NAME" \
  pg_restore --exit-on-error --no-owner --no-privileges \
  --username postgres --dbname ascn_restore /tmp/ascn.dump

TABLE_PRESENT="$(docker exec --env PGPASSWORD="$RESTORE_PASSWORD" "$CONTAINER_NAME" \
  psql --no-psqlrc --tuples-only --no-align --username postgres --dbname ascn_restore \
  --command "SELECT to_regclass('public.$REQUIRED_TABLE') IS NOT NULL")"
[[ "$TABLE_PRESENT" == "t" ]] || backup_die "required table was not restored: $REQUIRED_TABLE"

TABLE_COUNT="$(docker exec --env PGPASSWORD="$RESTORE_PASSWORD" "$CONTAINER_NAME" \
  psql --no-psqlrc --tuples-only --no-align --username postgres --dbname ascn_restore \
  --command "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[[ "$TABLE_COUNT" =~ ^[1-9][0-9]*$ ]] || backup_die "logical restore contains no public tables"

# Upload is acknowledged before recorded_seconds is committed. Therefore every
# recording referenced by the DB snapshot must exist either in the tenant S3
# export or, during migration only, in the protected legacy directory. Objects
# without a DB row are safe orphans from calls completed after pg_dump began.
EXPECTED_RECORDINGS_FILE="$RESTORE_DIRECTORY/expected-recordings.tsv"
docker exec --env PGPASSWORD="$RESTORE_PASSWORD" "$CONTAINER_NAME" \
  psql --no-psqlrc --tuples-only --no-align --field-separator=$'\t' \
  --username postgres --dbname ascn_restore \
  --command "SELECT tenant_id, id FROM ascn_call_records WHERE recorded_seconds > 0 ORDER BY tenant_id, id" \
  >"$EXPECTED_RECORDINGS_FILE"
EXPECTED_RECORDING_COUNT=0
MISSING_RECORDING_COUNT=0
while IFS=$'\t' read -r tenant_id call_id; do
  [[ -n "$tenant_id" && -n "$call_id" ]] || continue
  EXPECTED_RECORDING_COUNT=$((EXPECTED_RECORDING_COUNT + 1))
  if [[ ! "$tenant_id" =~ ^[a-zA-Z0-9._-]{1,128}$ \
    || ! "$call_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    backup_die "restored database contains an invalid recording identity"
  fi
  if [[ ! -f "$PAYLOAD_DIRECTORY/object-storage/$tenant_id/$call_id.wav" \
    && ! -f "$PAYLOAD_DIRECTORY/legacy-recordings/$call_id.wav" ]]; then
    MISSING_RECORDING_COUNT=$((MISSING_RECORDING_COUNT + 1))
    if (( MISSING_RECORDING_COUNT <= 20 )); then
      printf 'MISSING RECORDING: tenant=%s call=%s\n' "$tenant_id" "$call_id" >&2
    fi
  fi
done <"$EXPECTED_RECORDINGS_FILE"
(( MISSING_RECORDING_COUNT == 0 )) \
  || backup_die "$MISSING_RECORDING_COUNT database-referenced recordings are absent from the restored payload"

backup_log "restore validation completed successfully ($TABLE_COUNT tables, $ACTUAL_OBJECTS objects, $EXPECTED_RECORDING_COUNT DB recording references)"
