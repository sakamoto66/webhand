"""Book on a crowded local page: 300 category links come before the booking form in the DOM.

Without a view, the observation's 250-action limit is spent on the links and the form is cut.
No network, no bookings.
"""

import json
from pathlib import Path

ARRIVAL, DEPARTURE, REGION, GUEST = "12", "14", "30", "Dense Tester"

GOAL = (
    f"In the Booking form, set Arrival to arrival {ARRIVAL}, Departure to departure {DEPARTURE}, "
    f"and Region to region {REGION}, enter {GUEST} as Guest, and press Book. "
    "Do not touch any other field. Stop when Booking received is shown."
)

SCRIPT = [
    {"operation": "SELECT", "label": f"arrival {ARRIVAL}"},
    {"operation": "SELECT", "label": f"departure {DEPARTURE}"},
    {"operation": "SELECT", "label": f"region {REGION}"},
    {"operation": "TYPE_TEXT", "label": "Guest", "text": GUEST},
    {"operation": "CLICK", "label": "Book"},
]


def start_url(root: Path) -> str:
    return (root / "tasks" / "fixtures" / "dense.html").as_uri()


def verify(browser) -> dict:
    """Reads what the form submitted. It does not look at the agent's DONE or its history."""
    state = (
        browser.evaluate(
            "({booking: document.body.dataset.booking ?? null, result: document.getElementById('result')?.innerText})"
        )
        or {}
    )
    booking = json.loads(state.get("booking") or "{}")
    checks = {
        "submitted": state.get("result") == "Booking received",
        "arrival": booking.get("arrival") == ARRIVAL,
        "departure": booking.get("departure") == DEPARTURE,
        "region": booking.get("region") == REGION,
        "guest": booking.get("guest") == GUEST,
    }
    return {"success": all(checks.values()), "evidence": {"checks": checks, "booking": booking}}
