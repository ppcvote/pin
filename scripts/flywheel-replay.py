#!/usr/bin/env python3
"""Replay flywheel dead-letter events to the UltraLab ingestion endpoint.

The Pin runtime dead-letters failed flywheel events into
data/flywheel_dead_letter.log (one JSON object per line, shape
{"event": <FlywheelEvent>, "lastError": str, "ts": str} — see
src/runtime/flywheelReporter.ts). This script re-sends each event and
rewrites the log keeping only the lines that still fail.

The ingestion endpoint (UltraLab /api/flywheel-event) expects
{event: "<name>", source, meta} with the shared secret in the
`x-flywheel-key` header. Pass the secret via --secret-file or the
FLYWHEEL_WEBHOOK_SECRET env var — never hardcode it.

Usage:
  python scripts/flywheel-replay.py --secret-file <path-to-secret> \
      [--log data/flywheel_dead_letter.log] \
      [--url https://ultralab.tw/api/flywheel-event] [--dry-run]
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_LOG = os.path.join("data", "flywheel_dead_letter.log")
DEFAULT_URL = "https://ultralab.tw/api/flywheel-event"


def to_payload(pin_event: dict) -> dict:
    """Map a Pin FlywheelEvent object to the ingestion API body."""
    event_type = pin_event.get("type")
    meta = {}
    for key, value in pin_event.items():
        if key == "type":
            continue
        # meta values must be scalars; flatten nested objects (e.g. perSkill)
        meta[key] = value if isinstance(value, (str, int, float, bool)) or value is None else json.dumps(value)
    meta["replayed"] = True
    return {"event": event_type, "source": "pin", "meta": meta}


def send(url: str, secret: str, payload: dict) -> tuple[bool, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-flywheel-key": secret},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", "replace")
            ok = resp.status == 200 and json.loads(body or "{}").get("ok") is True
            return ok, f"HTTP {resp.status} {body.strip()}"
    except urllib.error.HTTPError as err:
        return False, f"HTTP {err.code} {err.read().decode('utf-8', 'replace').strip()}"
    except Exception as err:  # noqa: BLE001 — report any transport failure
        return False, f"{type(err).__name__}: {err}"


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--log", default=DEFAULT_LOG)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--secret-file", help="file containing the shared secret (overrides env)")
    parser.add_argument("--dry-run", action="store_true", help="print payloads without sending")
    args = parser.parse_args()

    secret = os.environ.get("FLYWHEEL_WEBHOOK_SECRET", "")
    if args.secret_file:
        with open(args.secret_file, encoding="utf-8") as fh:
            secret = fh.read().strip()
    if not secret and not args.dry_run:
        print("error: no secret — pass --secret-file or set FLYWHEEL_WEBHOOK_SECRET", file=sys.stderr)
        return 2

    if not os.path.exists(args.log):
        print(f"nothing to replay: {args.log} not found")
        return 0

    with open(args.log, encoding="utf-8") as fh:
        lines = [line for line in fh.read().splitlines() if line.strip()]
    if not lines:
        print("nothing to replay: log is empty")
        return 0

    kept: list[str] = []
    sent = 0
    for line in lines:
        try:
            entry = json.loads(line)
            payload = to_payload(entry["event"])
        except (json.JSONDecodeError, KeyError, TypeError) as err:
            print(f"keep (unparseable: {err}): {line[:120]}")
            kept.append(line)
            continue
        if args.dry_run:
            print(f"dry-run: {json.dumps(payload)}")
            kept.append(line)
            continue
        ok, detail = send(args.url, secret, payload)
        if ok:
            sent += 1
            print(f"sent {payload['event']}: {detail}")
        else:
            print(f"keep (send failed): {detail}")
            kept.append(line)

    if not args.dry_run:
        with open(args.log, "w", encoding="utf-8", newline="\n") as fh:
            for line in kept:
                fh.write(line + "\n")
    print(f"done: {sent} replayed, {len(kept)} kept")
    return 0 if not kept or args.dry_run else 1


if __name__ == "__main__":
    sys.exit(main())
