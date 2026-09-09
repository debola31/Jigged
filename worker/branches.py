"""Which databases this worker serves: production, and every live preview branch.

A Vercel preview deployment enqueues into the PR's OWN Supabase branch -- a
separate project with its own `ai_jobs` and `ai_workers` tables -- so a worker that
polls production alone leaves every preview's ask bar reading "the AI box is
offline", refused at enqueue because nothing heartbeats there.

Supabase is asked directly rather than GitHub: `GET /v1/projects/{ref}/branches` is
the source of truth for what exists, it names each branch's own project ref, and
`preview_project_status` says whether the database is up -- so a branch that is
still provisioning is skipped instead of being retried into connection errors. The
earlier answer to this problem scraped a PR check with `gh` and had neither
property.

THE CREDENTIAL IS THE SEED'S. `supabase/seed.sql` gives `jigged_ai_worker` and
`jigged_ai_readonly` a LOGIN on local and preview databases -- both roles are
NOLOGIN by migration, because a password in a migration file would be a credential
in git -- and the seed's own comment names this as one of the two reasons it does
so. Production never runs the seed; its credentials come from the environment and
are never derived here.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from worker import config as worker_config

logger = logging.getLogger("worker.branches")

SUPABASE_API = "https://api.supabase.com"
# Discovery must never be the reason a job waits: production is already being
# served from the environment, and a slow API just means a branch joins on the next
# pass.
DISCOVERY_TIMEOUT_S = 10.0
# The one status that means the database will accept a connection.
HEALTHY = "ACTIVE_HEALTHY"

_SEED = Path(__file__).resolve().parents[1] / "supabase/seed.sql"
_SEED_LOGIN = re.compile(r"^alter role jigged_ai_worker login password '([^']+)';", re.M)
# postgresql://<role>.<project_ref>:<password>@<pooler host>/postgres
_POOLER_USER = re.compile(r"^([^.]+)\.([a-z]{20})$")


@dataclass(frozen=True)
class Served:
    """One database this worker claims from, and the sandbox its jobs query.

    Both DSNs are built together from one ref, which is the invariant that keeps a
    preview's question off production's data: there is no combination of the two
    that names different databases.
    """

    ref: str
    label: str
    is_default: bool
    queue_dsn: str
    sandbox_dsn: str


def parse_pooler_dsn(dsn: str) -> tuple[str, str] | None:
    """The pooler host and project ref out of a Supabase pooler DSN, or None.

    Supabase's pooler takes the tenant as part of the username (`role.ref`), which
    is why production's own DSN is enough to address every branch of the project:
    same host, same shape, a different ref.

    NONE IS NOT AN ERROR. A direct connection, a local stack, or any DSN that is
    not pooler-shaped simply means branches cannot be addressed from it -- so the
    worker serves production and nothing else, which is what every shop box does
    anyway. Refusing to start over it would break workers that have no interest in
    previews at all.
    """
    parts = urlsplit(dsn)
    match = _POOLER_USER.match(parts.username or "")
    if not parts.hostname or not match:
        return None
    host = parts.hostname + (f":{parts.port}" if parts.port else "")
    return host, match.group(2)


def seed_login() -> str | None:
    """The login supabase/seed.sql gives the worker roles on non-production databases.

    Read rather than restated, so there is one definition of it and no credential
    in a second file. A repo without the seed simply serves no branches.
    """
    try:
        match = _SEED_LOGIN.search(_SEED.read_text())
    except OSError:
        logger.warning("cannot read %s; no preview branch can be served", _SEED)
        return None
    if not match:
        logger.warning(
            "supabase/seed.sql no longer gives jigged_ai_worker a login; no preview "
            "branch can be served"
        )
        return None
    return match.group(1)


def fetch_branches(parent_ref: str, token: str) -> list[dict]:
    """Every branch Supabase knows about for this project, or [] if it cannot say.

    NEVER RAISES. Discovery failing is not a reason to stop serving the databases
    already in hand, production above all: a revoked token or a flaky network would
    otherwise take the shop's own AI down with it.
    """
    try:
        response = httpx.get(
            f"{SUPABASE_API}/v1/projects/{parent_ref}/branches",
            headers={"Authorization": f"Bearer {token}"},
            timeout=DISCOVERY_TIMEOUT_S,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:  # noqa: BLE001 - see the docstring
        logger.warning("branch discovery failed (%s); serving what is already known", exc)
        return []
    return payload if isinstance(payload, list) else []


def discover(cfg: worker_config.Config) -> list[Served]:
    """The databases to serve, production first.

    Production comes from the environment with its real credentials and is ALWAYS
    in the list -- it is the shop's own database, and no API call can remove it.
    Branches are additive, healthy-only, and each is vetted by the same superuser
    refusal that guards the configured sandbox.
    """
    pooler = parse_pooler_dsn(cfg.database_url)
    parent_ref = pooler[1] if pooler else "production"
    production = Served(
        ref=parent_ref,
        label="production",
        is_default=True,
        queue_dsn=cfg.database_url,
        sandbox_dsn=cfg.readonly_database_url,
    )
    if not cfg.supabase_access_token or pooler is None:
        return [production]

    login = seed_login()
    if not login:
        return [production]
    host = pooler[0]

    served = [production]
    for branch in fetch_branches(parent_ref, cfg.supabase_access_token):
        ref = branch.get("project_ref")
        if not isinstance(ref, str) or branch.get("is_default") or ref == parent_ref:
            continue
        if branch.get("preview_project_status") != HEALTHY:
            logger.info(
                "branch %s (%s) is %s, not %s; skipping this pass",
                branch.get("git_branch") or ref, ref,
                branch.get("preview_project_status"), HEALTHY,
            )
            continue
        sandbox_dsn = f"postgresql://jigged_ai_readonly.{ref}:{login}@{host}/postgres?sslmode=require"
        try:
            worker_config.refuse_superuser_sandbox(sandbox_dsn, f"the sandbox DSN for branch {ref}")
        except worker_config.WorkerMisconfigured as exc:
            logger.error("%s", exc)
            continue
        served.append(Served(
            ref=ref,
            label=branch.get("git_branch") or ref,
            is_default=False,
            queue_dsn=f"postgresql://jigged_ai_worker.{ref}:{login}@{host}/postgres?sslmode=require",
            sandbox_dsn=sandbox_dsn,
        ))
    return served


__all__ = ["DISCOVERY_TIMEOUT_S", "HEALTHY", "Served", "discover", "fetch_branches",
           "parse_pooler_dsn", "seed_login"]
