"""Board meeting — the C-suite deliberates, then issues directives downward.

The CEO proposes, CFO checks budget/ROI, CTO checks feasibility, COO checks
capacity, CMO checks demand. Consensus → tasks published to divisions.
"""
ROLES = ("ceo", "cto", "cfo", "coo", "cmo")


async def convene(bus, agenda: list[dict]) -> None:
    for item in agenda:
        await bus.publish("BOARD_DIRECTIVE", item)
