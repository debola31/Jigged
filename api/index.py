import os
import sys
import logging
import sentry_sdk

# Sentry must not report from the test suite. `sentry_sdk.init` runs at import time,
# which under pytest happens during collection — before PYTEST_CURRENT_TEST is set —
# so the reliable signal is pytest already being in sys.modules. Without this,
# tests that deliberately provoke failures (a bad Stripe webhook signature, a Resend
# 500) get filed as High-priority production errors. That was 2 of the 23 issues in
# the backend queue, and they alerted every CI run.
_UNDER_PYTEST = "pytest" in sys.modules

# Add api directory to path for Vercel serverless functions
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client, Client
from dotenv import load_dotenv

from logging_config import setup_logging

# Configure logging
setup_logging()
logger = logging.getLogger(__name__)

# Load environment variables (.env.local is the Next.js convention used in this project)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env.local'))

def resolve_sentry_environment() -> str:
    """Which environment this process reports as, in precedence order.

    This was `os.getenv("ENVIRONMENT", "development")`, and ENVIRONMENT is never set on
    Vercel — so local dev, pytest, preview AND production all reported as "development".
    That is why the backend showed zero issues under `production` while real preview
    failures sat in the development bucket, indistinguishable from localhost noise.

    VERCEL_ENV is injected by Vercel itself (production | preview | development), so it
    can't drift the way a hand-set variable does. ENVIRONMENT stays as a fallback so a
    non-Vercel host can still name itself.
    """
    return os.getenv("VERCEL_ENV") or os.getenv("ENVIRONMENT") or "development"


# Initialize Sentry for error monitoring.
SENTRY_ENVIRONMENT = resolve_sentry_environment()

# Only DEPLOYED environments report, matching the frontend's
# `enabled: process.env.NODE_ENV === "production"` guard in instrumentation-client.ts.
#
# The pytest guard alone was not enough. `load_dotenv` above reads SENTRY_DSN out of
# .env.local, so a developer running `python api/index.py` reports to the real project —
# tagged `development`, but sitting in the same queue as production, and indistinguishable
# from it at a glance. Every deliberately-provoked local failure (a `stripe listen` secret
# that no longer matches, a QuickBooks sandbox 500) lands there as a real issue, which is
# one of the explanations for backend issues appearing after the code that filed them was
# already fixed.
_REPORTING_ENVIRONMENTS = {"production", "preview"}
_SENTRY_ENABLED = not _UNDER_PYTEST and SENTRY_ENVIRONMENT in _REPORTING_ENVIRONMENTS

# Disabling needs an EMPTY STRING, not None — there is no `enabled` kwarg, and a None
# dsn makes the SDK fall back to reading SENTRY_DSN from the environment, which
# `load_dotenv` above has already populated from .env.local. So `dsn=None` looks like
# "off" and is actually "on"; only a falsy-but-not-None value truly disables it.
sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN") if _SENTRY_ENABLED else "",
    traces_sample_rate=0.1,
    environment=SENTRY_ENVIRONMENT,
    send_default_pii=True,
)

# Initialize Supabase client.
# Prefer SUPABASE_SECRET_KEY (recommended); fall back to SUPABASE_SERVICE_ROLE_KEY
# — the name the Supabase<->Vercel branching integration injects — so preview
# deployments against a branch DB don't silently disable database features.
# Mirrors the fallback already used in operators_routes.py / admin_routes.py.
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not supabase_url or not supabase_key:
    logger.warning("SUPABASE_URL or SUPABASE_SECRET_KEY/SERVICE_ROLE_KEY not set - database features disabled")
    supabase: Client = None
else:
    supabase: Client = create_client(supabase_url, supabase_key)

app = FastAPI(
    title="Jigged API",
    description="Jigged Manufacturing Data Platform API",
    version="1.0.0",
)

# Configure CORS - handle empty string edge case properly
_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
ALLOWED_ORIGINS = [o.strip() for o in _origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"http://localhost:\d+$",  # Allow any localhost port
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Import and register routes
from routes.import_routes import router as import_router
from routes.parts_import_routes import router as parts_import_router
from routes.work_centers_import_routes import router as work_centers_import_router
from routes.vendors_import_routes import router as vendors_import_router
from routes.bom_import_routes import router as bom_import_router
from routes.routings_import_routes import router as routings_import_router
from routes.operators_routes import admin_router as operators_admin_router
from routes.insights_routes import router as insights_router
from routes.admin_routes import router as system_admin_router
from routes.quickbooks_routes import router as quickbooks_router
from routes.data_import_routes import router as data_import_router
from routes.stripe_routes import router as stripe_router

app.include_router(import_router)
app.include_router(parts_import_router)
app.include_router(work_centers_import_router)
app.include_router(vendors_import_router)
app.include_router(bom_import_router)
app.include_router(routings_import_router)
app.include_router(operators_admin_router)
app.include_router(insights_router)
app.include_router(system_admin_router)
app.include_router(quickbooks_router)
app.include_router(data_import_router)
app.include_router(stripe_router)


# For local development
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("index:app", host="0.0.0.0", port=8000, reload=True)
