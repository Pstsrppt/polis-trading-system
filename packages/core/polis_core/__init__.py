"""Base abstractions shared by everything: Agent, Skill, Task, Event, Result."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4


class Status(str, Enum):
    RUNNING = "running"; IDLE = "idle"; WARN = "warn"; DOWN = "down"


@dataclass
class Agent:
    """An AI employee. Loads skills at runtime — never hardcoded."""
    role: str
    division: str
    model: str = "gemini-2.0-flash-lite"
    version: str = "1.0"
    id: str = field(default_factory=lambda: str(uuid4()))
    status: Status = Status.IDLE
    personality: dict = field(default_factory=dict)   # Digital DNA: aggressive/fast/...
    skills: list[str] = field(default_factory=list)
    cost_today: float = 0.0
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class Task:
    id: str
    intent: str
    payload: dict
    division: str
    risk: float = 0.0
    cost_estimate: float = 0.0
