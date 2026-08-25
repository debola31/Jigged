"""Feature handlers: the work a job actually does, independent of where it runs."""
from services.ai_features.base import Handler, JobContext, handler_for

__all__ = ["Handler", "JobContext", "handler_for"]
