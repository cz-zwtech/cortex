#!/usr/bin/env bash
#
# secret-run — a TEMPLATE launcher wrapper to adapt to YOUR secret manager.
#
# Cortex expects secrets (the Anthropic API key for CKN_API_KEY_CMD, the mesh
# bearer token CKN_MESH_TOKEN, …) to be fetched at the launcher boundary rather
# than stored in dotfiles, .env, or systemd units. This wrapper fetches the
# named keys from your manager, injects them ONLY into the environment of the
# child command, and exec's it. Fetched values never touch disk and are never
# logged.
#
# Adapt fetch_secret() below to your manager: OpenBao / HashiCorp Vault,
# 1Password CLI (op), pass, a cloud secret store, etc.
#
# Usage: secret-run KEY1 KEY2 ... -- command args...
#   e.g. secret-run ANTHROPIC_API_KEY -- printenv ANTHROPIC_API_KEY
#        secret-run CKN_MESH_TOKEN -- npm run server

set -euo pipefail

keys=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  keys+=("$1")
  shift
done
[[ "${1:-}" == "--" ]] || { echo "secret-run: missing '--' separator" >&2; exit 64; }
shift
[[ $# -gt 0 ]] || { echo "secret-run: no command after '--'" >&2; exit 64; }

# --- PLACEHOLDER: implement for your secret manager -------------------------
# Echo the secret value for $1 to stdout (nothing else). Examples:
#   OpenBao/Vault KV v2 via curl+jq:
#     curl -sf -H "X-Vault-Token: $VAULT_TOKEN" \
#       "$VAULT_ADDR/v1/secret/data/cortex" | jq -er ".data.data[\"$1\"]"
#   1Password CLI:   op read "op://Vault/cortex/$1"
#   pass:            pass show "cortex/$1"
fetch_secret() {
  # TODO: replace with your manager
  echo "secret-run: fetch_secret is a placeholder — implement it" >&2
  return 1
}
# ---------------------------------------------------------------------------

env_pairs=()
for key in "${keys[@]}"; do
  value="$(fetch_secret "$key")"
  [[ -n "$value" ]] || { echo "secret-run: empty value for '$key'" >&2; exit 67; }
  env_pairs+=("$key=$value")
done

exec env "${env_pairs[@]}" "$@"
