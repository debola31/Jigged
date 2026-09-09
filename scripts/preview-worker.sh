#!/usr/bin/env bash
# Serve AI Insights on a PR's Vercel preview from this Mac, for as long as you are testing it.
#
#   scripts/preview-worker.sh <pr-number>        # Ctrl-C stops it
#
# WHY. A preview deployment talks to the PR's Supabase BRANCH, not production, and the
# worker on this Mac polls production only. Nothing heartbeats in the branch, so the
# preview's route answers every question with "the AI box is offline". A worker
# serves one database, so a preview gets a second one, on demand.
#
# WHAT IT NEEDS. `gh` (the branch's project ref is read from the PR's "Supabase
# Preview" check), `.env.local` (the region pooler host is reused from
# WORKER_DATABASE_URL, minus its credentials), and the conda env `jigged`. No new
# credential: on local and preview databases supabase/seed.sql gives jigged_ai_worker
# and jigged_ai_readonly a login, read from the seed itself. Production never has it,
# and this script refuses the production ref outright.
#
# WHILE IT RUNS. Both workers share the one Ollama (OLLAMA_NUM_PARALLEL=1), so a
# production question asked during a preview job waits behind it. WORKER_MODELS and
# the rest come from .env.local, the same as the production worker; export them to
# override (exported values win, override=False).
set -euo pipefail

pr="${1:?usage: scripts/preview-worker.sh <pr-number>}"
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "no .env.local here; the pooler host comes from its WORKER_DATABASE_URL" >&2; exit 1; }

link=$(gh pr checks "$pr" --json name,link --jq '.[] | select(.name == "Supabase Preview") | .link' | head -1)
ref=$(sed -nE 's#.*/project/([a-z]{20}).*#\1#p' <<<"$link")
[ -n "$ref" ] || { echo "PR #$pr has no Supabase Preview check yet; the branch is still provisioning" >&2; exit 1; }

prod_url=$(grep '^WORKER_DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')
host=$(sed -E 's#.*@([^/]+)/.*#\1#' <<<"$prod_url")
prod_ref=$(sed -nE 's#^[^/]*//[^.]+\.([a-z]{20})[:@].*#\1#p' <<<"$prod_url")
[ -n "$host" ] || { echo "WORKER_DATABASE_URL in .env.local has no host" >&2; exit 1; }
if [ "$ref" = "$prod_ref" ]; then
  echo "refusing: $ref is the production project, not a preview branch" >&2; exit 1
fi

# The login supabase/seed.sql gives both roles on local and preview databases, read
# from the seed so there is one definition of it (production never runs the seed).
seed_login=$(sed -nE "s/^alter role jigged_ai_worker login password '([^']+)';.*/\1/p" supabase/seed.sql | head -1)
[ -n "$seed_login" ] || { echo "supabase/seed.sql no longer gives jigged_ai_worker a login; nothing to connect with" >&2; exit 1; }

export WORKER_ID="${WORKER_ID:-preview-$(hostname -s)}"
export WORKER_DATABASE_URL="postgresql://jigged_ai_worker.${ref}:${seed_login}@${host}/postgres?sslmode=require"
export WORKER_READONLY_DATABASE_URL="postgresql://jigged_ai_readonly.${ref}:${seed_login}@${host}/postgres?sslmode=require"

# The env's python itself, not `conda run`: exec'd, so Ctrl-C and SIGTERM reach the
# worker (it finishes the job in hand and stops) instead of a wrapper.
py=$(conda run -n jigged python -c 'import sys; print(sys.executable)')
echo "PR #$pr -> Supabase branch $ref via $host, as worker $WORKER_ID. Ctrl-C to stop."
exec "$py" -m worker
