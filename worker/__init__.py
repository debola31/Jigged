"""The desktop AI worker: an outbound-only puller for the ai_jobs queue.

NO INBOUND TUNNEL, BY DESIGN. This process polls Supabase over an outbound
connection, runs Ollama at localhost, and writes results back. Nothing dials in,
so there is no ingress to secure, no cloudflared, and no Access policy.
"""
