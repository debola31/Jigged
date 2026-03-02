import os
import sys
import logging

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

# Load environment variables
load_dotenv()

# Initialize Supabase client
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_SECRET_KEY")

if not supabase_url or not supabase_key:
    logger.warning("SUPABASE_URL or SUPABASE_SECRET_KEY not set - database features disabled")
    supabase: Client = None
else:
    supabase: Client = create_client(supabase_url, supabase_key)

app = FastAPI(
    title="Jigged API",
    description="Jigged Manufacturing ERP API",
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
from routes.operations_import_routes import router as operations_import_router
from routes.operators_routes import admin_router as operators_admin_router
from routes.inventory_routes import router as inventory_router
from routes.waitlist_routes import router as waitlist_router

app.include_router(import_router)
app.include_router(parts_import_router)
app.include_router(operations_import_router)
app.include_router(operators_admin_router)
app.include_router(inventory_router)
app.include_router(waitlist_router)


@app.get("/api/example_name")
def get_example_name():
    return {"data": {"name": "Adebola Akeredolu"}}


@app.get("/api/data")
def get_sample_data():
    return {
        "data": [
            {"id": 1, "name": "Sample Item 1", "value": 100},
            {"id": 2, "name": "Sample Item 2", "value": 200},
            {"id": 3, "name": "Sample Item 3", "value": 300},
        ],
        "total": 3,
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/api/items/{item_id}")
def get_item(item_id: int):
    return {
        "item": {
            "id": item_id,
            "name": "Sample Item " + str(item_id),
            "value": item_id * 100,
        },
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/api/users")
def get_users():
    """
    Fetch all users from the Test.users table in Supabase
    """
    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized. Check environment variables.",
        )

    try:
        # Query the Test.users table

        response = supabase.table("users").select("*").execute()

        return {"data": response.data, "count": len(response.data)}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching users from Supabase: {str(e)}"
        )


# For local development
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("index:app", host="0.0.0.0", port=8000, reload=True)
