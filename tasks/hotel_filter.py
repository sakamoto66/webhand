"""Local hotel search. The fixture comes from jev-ultrafast (MIT). No network, no bookings."""

from pathlib import Path

GOAL = (
    "Find a stay in Lisbon in the Design category with free cancellation, "
    "then open the page for Casa Flora. Stop on that page."
)

SCRIPT = [
    {"operation": "TYPE_TEXT", "label": "Destination", "text": "Lisbon"},
    {"operation": "CLICK", "label": "Find stays"},
    {"operation": "SELECT", "label": "Design"},
    {"operation": "CLICK", "label": "Free cancellation"},
    {"operation": "CLICK", "label": "View Casa Flora"},
]


def start_url(root: Path) -> str:
    return (root / "tasks" / "fixtures" / "hotel.html").as_uri() + "?scenario=travel"


def verify(browser) -> dict:
    """Reads the final page directly. It does not look at the agent's DONE or its history."""
    state = browser.evaluate(
        "({heading: document.querySelector('h1')?.innerText, "
        "note: document.querySelector('.fixture-note')?.innerText, hash: location.hash})"
    )
    note = (state or {}).get("note") or ""
    checks = {
        "opened_casa_flora": (state or {}).get("heading") == "Casa Flora" and state["hash"] == "#casa-flora",
        "category_design": "Design" in note,
        "free_cancellation": "Free cancellation enabled" in note,
        "destination_lisbon": "Destination Lisbon" in note,
    }
    return {"success": all(checks.values()), "evidence": checks}
