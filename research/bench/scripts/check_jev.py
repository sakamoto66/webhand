"""Checks that Jev could be called in a finished session: python check_jev.py bu2-001

Exits 1 when Jev refused for the account (HTTP 401, 402 or 403), so the round stops instead of running the next
tasks without Jev. Writes the reason to work/<id>/invalid: such a session is kept but not scored or compared.
Added 2026-11-12, after Jev's credit ran out partway through rounds fv1 and fv2.
"""

import json
import re
import sys

from common import WORK

ACCOUNT = re.compile(r"Jev returned HTTP (401|402|403)")

task_id = sys.argv[1]
work = WORK / task_id
calls = refused = 0
for log in (work / "home" / "runs").glob("*/*.jsonl"):
    for line in log.read_text().split("\n"):
        if not line:
            continue
        event = json.loads(line)
        if event.get("type") == "call":
            calls += 1
        elif event.get("type") != "call" and ACCOUNT.search(json.dumps(event)):
            # Escalations carry it in detail; a failed --collect or --more carries it in error (bu2-173).
            refused += 1
if refused:
    (work / "invalid").write_text(f"Jev refused for the account {refused} times ({calls} calls succeeded)\n")
    print(f"{task_id}: Jev refused for the account {refused} times; marked invalid")
    sys.exit(1)
