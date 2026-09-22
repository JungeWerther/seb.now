"""Domain models mirroring the `public.links` table."""

from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Literal
from uuid import UUID

from pydantic import BaseModel


class Link(BaseModel):
    __tablename__: ClassVar[str] = "links"

    id: UUID
    submitted_by: UUID | None = None
    url: str
    title: str
    description: str | None = None
    origin: Literal["local", "fediverse", "feed"]
    fediverse_post_uri: str | None = None
    created_at: datetime
