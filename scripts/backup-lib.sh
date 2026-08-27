#!/usr/bin/env bash

# Shared, source-only helpers for backup.sh and restore-test.sh.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' "This file must be sourced, not executed." >&2
  exit 64
fi

backup_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

backup_log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

backup_require_command() {
  command -v "$1" >/dev/null 2>&1 || backup_die "required command is missing: $1"
}

backup_require_variable() {
  local name="$1"
  [[ -n "${!name:-}" ]] || backup_die "required variable is empty: $name"
}

backup_secure_file() {
  local pathname="$1" label="$2" mode owner
  [[ "$pathname" == /* ]] || backup_die "$label must use an absolute path"
  [[ -f "$pathname" && ! -L "$pathname" ]] || backup_die "$label must be a regular, non-symlink file"
  mode="$(stat -c '%a' "$pathname")" || backup_die "cannot inspect $label permissions"
  owner="$(stat -c '%u' "$pathname")" || backup_die "cannot inspect $label owner"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || backup_die "cannot parse $label permissions"
  (( (8#$mode & 8#077) == 0 )) || backup_die "$label must not be readable or writable by group/others (mode 0600 or 0400)"
  [[ "$owner" == "$EUID" ]] || backup_die "$label must be owned by uid $EUID"
  [[ -s "$pathname" ]] || backup_die "$label is empty"
}

backup_regular_file() {
  local pathname="$1" label="$2"
  [[ "$pathname" == /* ]] || backup_die "$label must use an absolute path"
  [[ -f "$pathname" && ! -L "$pathname" ]] || backup_die "$label must be a regular, non-symlink file"
}

backup_load_environment() {
  local env_file="${BACKUP_ENV_FILE:-}"
  [[ -n "$env_file" ]] || return 0
  backup_secure_file "$env_file" "BACKUP_ENV_FILE"
  set -a
  # This root-owned file is an administrator-controlled shell environment file.
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

backup_validate_common() {
  backup_require_command restic
  backup_require_command stat
  backup_require_command install
  backup_require_variable RESTIC_REPOSITORY
  backup_require_variable RESTIC_PASSWORD_FILE
  backup_require_variable RESTIC_S3_ACCESS_KEY_ID
  backup_require_variable RESTIC_S3_SECRET_ACCESS_KEY
  backup_require_variable BACKUP_SOURCE_ID
  backup_require_variable BACKUP_OFFSITE_CONFIRMED

  [[ "$RESTIC_REPOSITORY" == s3:* ]] || backup_die "RESTIC_REPOSITORY must be an off-site s3: repository"
  [[ "$BACKUP_OFFSITE_CONFIRMED" == "YES_I_HAVE_VERIFIED" ]] \
    || backup_die "set BACKUP_OFFSITE_CONFIRMED=YES_I_HAVE_VERIFIED only after verifying failure-domain separation"
  [[ "$BACKUP_SOURCE_ID" =~ ^[a-zA-Z0-9._-]{1,80}$ ]] || backup_die "BACKUP_SOURCE_ID has an invalid format"
  [[ "$RESTIC_S3_ACCESS_KEY_ID" != *$'\n'* && "$RESTIC_S3_SECRET_ACCESS_KEY" != *$'\n'* ]] \
    || backup_die "restic credentials contain a newline"
  backup_secure_file "$RESTIC_PASSWORD_FILE" "RESTIC_PASSWORD_FILE"
}

backup_prepare_work_directory() {
  BACKUP_WORK_DIR="${BACKUP_WORK_DIR:-/var/lib/ascn-backup}"
  [[ "$BACKUP_WORK_DIR" == /* ]] || backup_die "BACKUP_WORK_DIR must be absolute"
  [[ ! -L "$BACKUP_WORK_DIR" ]] || backup_die "BACKUP_WORK_DIR must not be a symlink"
  install -d -m 0700 "$BACKUP_WORK_DIR"
  [[ "$(stat -c '%u' "$BACKUP_WORK_DIR")" == "$EUID" ]] || backup_die "BACKUP_WORK_DIR has the wrong owner"
  chmod 0700 "$BACKUP_WORK_DIR"
  # ProtectHome=true hides root's normal cache path in the systemd units.
  # Keeping restic cache here also makes its writable scope explicit.
  RESTIC_CACHE_DIR="$BACKUP_WORK_DIR/restic-cache"
  install -d -m 0700 "$RESTIC_CACHE_DIR"
  export RESTIC_CACHE_DIR
}

restic_run() {
  local args=()
  if [[ -n "${RESTIC_CACERT:-}" ]]; then
    backup_regular_file "$RESTIC_CACERT" "RESTIC_CACERT"
    args+=(--cacert "$RESTIC_CACERT")
  fi
  AWS_ACCESS_KEY_ID="$RESTIC_S3_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$RESTIC_S3_SECRET_ACCESS_KEY" \
  AWS_SESSION_TOKEN="${RESTIC_S3_SESSION_TOKEN:-}" \
  AWS_DEFAULT_REGION="${RESTIC_S3_REGION:-us-east-1}" \
  AWS_EC2_METADATA_DISABLED=true \
    restic "${args[@]}" "$@"
}
