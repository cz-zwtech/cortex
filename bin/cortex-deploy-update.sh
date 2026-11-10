#!/usr/bin/env bash
# Update a shared deploy checkout (home: /srv/cortex/cortex-v2-deploy) so every
# user in its group can run it and update it next time.
#
# /srv/cortex gives the developers group rwx by default ACL, but git and npm
# write some files with fixed modes (npm unpacks package files 0644), which
# would leave them writable only by whoever updated last. So: a group-shared
# git repo, umask 002, and g+rwX over every file this user owns.
#
# Usage, as any user in the checkout's group:  bin/cortex-deploy-update.sh [--no-pull]
set -euo pipefail
case "${1:-}" in -h|--help)
  echo "usage: cortex-deploy-update.sh [--no-pull]   update this shared deploy checkout: pull, npm ci, group perms, re-sync commands"
  exit 0 ;;
esac
cd "$(dirname "$0")/.."
umask 002
# git refuses a repository owned by another user (CVE-2022-24765), and in a
# shared checkout that is everyone but its creator. Trust this one directory.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$(pwd)" || git config --global --add safe.directory "$(pwd)"
git config core.sharedRepository group
[ "${1:-}" = "--no-pull" ] || git pull --ff-only
npm ci --no-audit --no-fund
# npm builds node_modules elsewhere and moves it in, so it arrives with the
# user's own group, not the checkout's: put it back, then make it writable.
# Only an owner can chgrp or chmod; whatever another user wrote, that user
# fixed last time.
group=$(stat -c %G .)
find . -user "$(id -u)" ! -type l ! -group "$group" -exec chgrp "$group" {} +
find . -user "$(id -u)" ! -type l -exec chmod g+rwX {} +
# Commands live in each user's own ~/.claude: re-sync this user's now. Other users' re-sync at their next
# session start (the SessionStart hook does it), since a deploy cannot write their home dirs.
node_modules/.bin/tsx bin/cortex-setup.ts commands || echo "command re-sync failed; run: cortex-setup commands"
echo "deploy checkout $(pwd) at $(git log --oneline -1)"
