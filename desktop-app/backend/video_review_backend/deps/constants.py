"""Static enum-like constants used across routers and validators."""
from __future__ import annotations


# Allowed competition categories (qualification / final / team final / all-around).
ALLOWED_CATEGORIES: set[str] = {"EF", "AA", "TF", "QF"}

# Sport item id sets, partitioned by sex (0 = MAG, 1 = WAG).
MAG_SPORT_ITEM_IDS: set[int] = {0, 1, 2, 3, 4, 5}
WAG_SPORT_ITEM_IDS: set[int] = {0, 3, 6, 7}
