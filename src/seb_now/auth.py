"""Helpers for obtaining Supabase client sessions."""

from __future__ import annotations

import os

from dotenv import find_dotenv, load_dotenv
from supabase import Client, create_client

load_dotenv(find_dotenv(usecwd=True))


def get_unauthenticated_client() -> Client:
    """Return a Supabase client using the public anon key, with no signed-in user.

    RLS on every table gates what this session can do. Never pass the
    service_role key to this function.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env)."
        )
    return create_client(url, key)
