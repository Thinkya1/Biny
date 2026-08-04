"""Load the matching Harbor or Pier Python API.

Pier carries a parallel ``pier.*`` package tree.  Importing Harbor's classes
when Pier is present creates objects that look compatible but fail Pier's
Pydantic validation, so the adapter selects one tree at import time.
"""

from __future__ import annotations

import importlib
from typing import Any

try:
    import pier  # noqa: F401
except ModuleNotFoundError as error:
    if error.name != "pier":
        raise
    _TREE = "harbor"
else:
    _TREE = "pier"


def _load(module: str, name: str) -> Any:
    return getattr(importlib.import_module(f"{_TREE}.{module}"), name)


BaseAgent = _load("agents.base", "BaseAgent")
BaseEnvironment = _load("environments.base", "BaseEnvironment")
AgentContext = _load("models.agent.context", "AgentContext")
