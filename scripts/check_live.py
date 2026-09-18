#!/usr/bin/env python3
"""
Standalone tester for the OptiGrid Lens API.

No repository, no Node, no API key, no pip install - Python 3.8+ standard
library only. Point it at the live service and a JSON file of cases.

    python check_live.py
    python check_live.py --cases my_cases.json
    python check_live.py --url https://optigridlens.vercel.app --cases my_cases.json
    python check_live.py --verbose

It POSTs each case, then independently verifies the response the same way the
judge does: response schema, interpretation against expected values (when the
file supplies them), and a full hour-by-hour replay of the schedule against the
directives - energy balance, effective solar, battery bounds and rate limits,
directive windows, end-of-day neutrality, and the reported totals.

Case file shapes accepted:
    {"cases": [{"id": "...", "input": {...}, "expected_output": {...}}]}
    [{...scenario...}, {...scenario...}]
    {...scenario...}

`expected_output` is optional. Without it a case is still checked for schema
validity and for whether the schedule honours the directives the service itself
reported - which catches "extracted but never applied".
"""

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "https://optigridlens.vercel.app"
TOLERANCE = 0.01

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


# --- a tiny built-in case so the script is useful with no file at all --------

BUILTIN = {
    "cases": [
        {
            "id": "BUILTIN-solar-and-distractor",
            "input": {
                "scenario_id": "BUILTIN-1",
                "operator_notes": [
                    "Solar output will drop to about 20% from 1 PM to 3 PM.",
                    "The cafeteria menu changes tomorrow.",
                ],
                "hours": [
                    {"hour": h, "demand_kwh": d, "solar_kwh": s, "tariff_bdt_per_kwh": t}
                    for h, d, s, t in [
                        (0, 90, 0, 6), (1, 85, 0, 6), (2, 80, 0, 5), (3, 80, 0, 5),
                        (4, 85, 0, 5), (5, 95, 0, 6), (6, 110, 5, 8), (7, 130, 20, 10),
                        (8, 150, 50, 12), (9, 165, 90, 14), (10, 175, 130, 16),
                        (11, 180, 160, 16), (12, 185, 180, 15), (13, 180, 170, 14),
                        (14, 170, 140, 13), (15, 165, 90, 14), (16, 170, 45, 18),
                        (17, 185, 10, 22), (18, 205, 0, 28), (19, 215, 0, 30),
                        (20, 205, 0, 26), (21, 175, 0, 18), (22, 135, 0, 10),
                        (23, 105, 0, 7),
                    ]
                ],
                "battery": {
                    "capacity_kwh": 220,
                    "initial_energy_kwh": 110,
                    "minimum_energy_kwh": 40,
                    "max_charge_kwh_per_hour": 50,
                    "max_discharge_kwh_per_hour": 50,
                },
            },
            "expected_output": {
                "directive_interpretation": [
                    {
                        "note_index": 0,
                        "applies": True,
                        "directive_type": "solar_reduction",
                        "structured_adjustment": {"hours": [13, 14], "factor": 0.2},
                    },
                    {
                        "note_index": 1,
                        "applies": False,
                        "directive_type": "no_op",
                        "structured_adjustment": None,
                    },
                ]
            },
        }
    ]
}

REQUIRED_KEYS = [
    "scenario_id",
    "directive_interpretation",
    "hourly_plan",
    "total_grid_kwh",
    "total_cost_bdt",
    "peak_grid_kwh",
    "plan_summary",
]


def post(url, payload, timeout=40):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"error": raw[:200]}


def check_schema(body, note_count):
    """Contract checks the judge scores under API Contract & Schema."""
    problems = []
    if not isinstance(body, dict):
        return ["response is not a JSON object"]

    for key in REQUIRED_KEYS:
        if key not in body:
            problems.append("missing field %s" % key)
    for key in body:
        if key not in REQUIRED_KEYS:
            problems.append("unexpected field %s" % key)

    plan = body.get("hourly_plan")
    if not isinstance(plan, list) or len(plan) != 24:
        problems.append("hourly_plan must have 24 entries, got %s" % (
            len(plan) if isinstance(plan, list) else type(plan).__name__))

    entries = body.get("directive_interpretation")
    if not isinstance(entries, list):
        problems.append("directive_interpretation is not a list")
        return problems

    if [e.get("note_index") for e in entries] != list(range(note_count)):
        problems.append("note_index sequence is %s, expected 0..%d" % (
            [e.get("note_index") for e in entries], note_count - 1))

    for e in entries:
        is_noop = e.get("directive_type") == "no_op"
        if is_noop and (e.get("applies") or e.get("structured_adjustment") is not None):
            problems.append("note %s: no_op needs applies=false and a null adjustment"
                            % e.get("note_index"))
        if not is_noop and not e.get("applies"):
            problems.append("note %s: %s needs applies=true"
                            % (e.get("note_index"), e.get("directive_type")))
        adj = e.get("structured_adjustment")
        if isinstance(adj, dict):
            hours = adj.get("hours", [])
            if hours != sorted(set(hours)):
                problems.append("note %s: hours must be unique and ascending, got %s"
                                % (e.get("note_index"), hours))
            if any((not isinstance(h, int)) or h < 0 or h > 23 for h in hours):
                problems.append("note %s: hours outside 0-23" % e.get("note_index"))
    return problems


def compile_constraints(scenario, directives):
    """Per-hour limits after applying every directive."""
    battery = scenario["battery"]
    hours = scenario["hours"]
    effective = [h["solar_kwh"] for h in hours]
    min_level = [battery["minimum_energy_kwh"]] * 24
    max_grid = [float("inf")] * 24
    can_charge = [True] * 24
    can_discharge = [True] * 24

    for d in directives:
        kind = d.get("directive_type")
        adj = d.get("structured_adjustment") or {}
        for h in adj.get("hours", []):
            if kind == "solar_reduction":
                effective[h] = min(effective[h], hours[h]["solar_kwh"] * adj["factor"])
            elif kind == "minimum_battery_reserve":
                min_level[h] = max(min_level[h], adj["minimum_energy_kwh"])
            elif kind == "max_grid_window":
                max_grid[h] = min(max_grid[h], adj["max_grid_kwh"])
            elif kind == "no_charge_window":
                can_charge[h] = False
            elif kind == "no_discharge_window":
                can_discharge[h] = False
    return effective, min_level, max_grid, can_charge, can_discharge


def replay(scenario, directives, plan, reported):
    """Independent hour-by-hour verification. Mirrors Section 11 of the spec."""
    problems = []
    battery = scenario["battery"]
    hours = scenario["hours"]
    effective, min_level, max_grid, can_charge, can_discharge = compile_constraints(
        scenario, directives)

    by_hour = {}
    for entry in plan:
        h = entry.get("hour")
        if h in by_hour:
            problems.append("hour %s appears more than once" % h)
        by_hour[h] = entry

    level = battery["initial_energy_kwh"]
    total_grid = total_cost = peak = 0.0

    for h in range(24):
        e = by_hour.get(h)
        if e is None:
            problems.append("hour %d missing from hourly_plan" % h)
            continue

        grid = e.get("grid_kwh", 0)
        solar = e.get("solar_used_kwh", 0)
        action = e.get("battery_action")
        amount = e.get("battery_kwh", 0)

        for name, value in (("grid_kwh", grid), ("solar_used_kwh", solar),
                            ("battery_kwh", amount)):
            if not isinstance(value, (int, float)) or value < 0:
                problems.append("h%d: %s must be a non-negative number" % (h, name))

        if action not in ("charge", "discharge", "idle"):
            problems.append("h%d: invalid battery_action %r" % (h, action))
            continue

        charge = amount if action == "charge" else 0
        discharge = amount if action == "discharge" else 0

        if action == "idle" and abs(amount) > TOLERANCE:
            problems.append("h%d: idle hour must have battery_kwh 0, got %s" % (h, amount))
        if solar > effective[h] + TOLERANCE:
            problems.append("h%d: solar_used %s exceeds effective solar %.2f"
                            % (h, solar, effective[h]))

        supply = grid + solar + discharge
        draw = hours[h]["demand_kwh"] + charge
        if abs(supply - draw) > TOLERANCE:
            problems.append("h%d: energy balance off by %.3f kWh" % (h, supply - draw))

        if charge > battery["max_charge_kwh_per_hour"] + TOLERANCE:
            problems.append("h%d: charge %s exceeds limit %s"
                            % (h, charge, battery["max_charge_kwh_per_hour"]))
        if discharge > battery["max_discharge_kwh_per_hour"] + TOLERANCE:
            problems.append("h%d: discharge %s exceeds limit %s"
                            % (h, discharge, battery["max_discharge_kwh_per_hour"]))

        if not can_charge[h] and charge > TOLERANCE:
            problems.append("h%d: charged %s inside a no_charge_window" % (h, charge))
        if not can_discharge[h] and discharge > TOLERANCE:
            problems.append("h%d: discharged %s inside a no_discharge_window" % (h, discharge))
        if grid > max_grid[h] + TOLERANCE:
            problems.append("h%d: grid %s exceeds max_grid_window cap %s"
                            % (h, grid, max_grid[h]))

        level = level + charge - discharge
        if abs(level - e.get("battery_energy_after_kwh", 0)) > TOLERANCE:
            problems.append("h%d: battery_energy_after_kwh %s, replayed %.3f"
                            % (h, e.get("battery_energy_after_kwh"), level))
        if level < min_level[h] - TOLERANCE:
            problems.append("h%d: battery %.2f below required minimum %s"
                            % (h, level, min_level[h]))
        if level > battery["capacity_kwh"] + TOLERANCE:
            problems.append("h%d: battery %.2f above capacity %s"
                            % (h, level, battery["capacity_kwh"]))

        total_grid += grid
        total_cost += grid * hours[h]["tariff_bdt_per_kwh"]
        peak = max(peak, grid)

    if abs(level - battery["initial_energy_kwh"]) > TOLERANCE:
        problems.append("battery ends at %.2f, must return to %s"
                        % (level, battery["initial_energy_kwh"]))

    for key, actual in (("total_grid_kwh", total_grid),
                        ("total_cost_bdt", total_cost),
                        ("peak_grid_kwh", peak)):
        claimed = reported.get(key)
        if claimed is None or abs(claimed - actual) > TOLERANCE:
            problems.append("%s reported %s, recalculated %.2f" % (key, claimed, actual))

    return problems, total_cost


def adjustments_match(got, want):
    """Hours exactly, numbers within the 0.01 tolerance the spec defines."""
    if got is None or want is None:
        return got == want
    if got.get("hours") != want.get("hours"):
        return False
    for field in ("factor", "minimum_energy_kwh", "max_grid_kwh"):
        a, b = got.get(field), want.get(field)
        if a is None and b is None:
            continue
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
            if a != b:
                return False
        elif abs(a - b) > TOLERANCE:
            return False
    return True


def grade(got_entries, want_entries):
    problems, correct = [], 0
    for i, want in enumerate(want_entries):
        got = got_entries[i] if i < len(got_entries) else None
        if got is None:
            problems.append("note %d: no entry returned" % i)
            continue
        issues = []
        if got.get("directive_type") != want.get("directive_type"):
            issues.append("directive_type: expected %s, got %s"
                          % (want.get("directive_type"), got.get("directive_type")))
        if got.get("applies") != want.get("applies"):
            issues.append("applies: expected %s, got %s"
                          % (want.get("applies"), got.get("applies")))
        if not adjustments_match(got.get("structured_adjustment"),
                                 want.get("structured_adjustment")):
            issues.append("adjustment: expected %s, got %s"
                          % (json.dumps(want.get("structured_adjustment")),
                             json.dumps(got.get("structured_adjustment"))))
        if issues:
            problems.extend("note %d: %s" % (i, s) for s in issues)
        else:
            correct += 1
    return correct, problems


def load_cases(path):
    if path is None:
        raw = BUILTIN
    else:
        raw = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    items = raw if isinstance(raw, list) else raw.get("cases", [raw])
    out = []
    for i, item in enumerate(items):
        data = item.get("input", item)
        out.append({
            "id": str(item.get("id") or data.get("scenario_id") or "case-%d" % i),
            "input": data,
            "expected": item.get("expected_output"),
        })
    return out


def main():
    ap = argparse.ArgumentParser(description="Test the OptiGrid Lens API end to end.")
    ap.add_argument("--url", default=DEFAULT_URL, help="base URL of the service")
    ap.add_argument("--cases", help="JSON file of cases (default: one built-in case)")
    ap.add_argument("--filter", help="only run case ids containing this string")
    ap.add_argument("--verbose", action="store_true", help="print each interpretation")
    args = ap.parse_args()

    base = args.url.rstrip("/")
    cases = load_cases(args.cases)
    if args.filter:
        cases = [c for c in cases if args.filter in c["id"]]

    print("\nOptiGrid Lens live check")
    print("  target : %s" % base)
    print("  source : %s (%d cases)\n" % (args.cases or "built-in", len(cases)))

    try:
        with urllib.request.urlopen(base + "/health", timeout=20) as r:
            health = json.loads(r.read().decode())
        print("  health : %s\n" % health)
    except Exception as exc:
        print("  %shealth check failed: %s%s\n" % (RED, exc, RESET))
        return 1

    passed = failed = notes_ok = notes_total = valid = 0
    latencies = []

    for case in cases:
        started = time.time()
        try:
            status, body = post(base + "/optimize-energy", case["input"])
        except Exception as exc:
            print("%sFAIL%s  %-28s request error: %s" % (RED, RESET, case["id"], exc))
            failed += 1
            continue
        elapsed = time.time() - started
        latencies.append(elapsed)

        if status != 200:
            print("%sFAIL%s  %-28s HTTP %s %s"
                  % (RED, RESET, case["id"], status, json.dumps(body)[:120]))
            failed += 1
            continue

        problems = check_schema(body, len(case["input"]["operator_notes"]))
        note_summary = "notes %d (ungraded)" % len(body.get("directive_interpretation", []))

        if case["expected"] and case["expected"].get("directive_interpretation"):
            want = case["expected"]["directive_interpretation"]
            correct, issues = grade(body["directive_interpretation"], want)
            notes_ok += correct
            notes_total += len(want)
            problems.extend(issues)
            note_summary = "notes %d/%d" % (correct, len(want))
            directives = want
        else:
            directives = body.get("directive_interpretation", [])

        replay_problems, cost = replay(
            case["input"], directives, body.get("hourly_plan", []), body)
        if not replay_problems:
            valid += 1
        problems.extend(replay_problems)

        if problems:
            failed += 1
            print("%sFAIL%s  %-28s %4.1fs  %s  cost %.2f"
                  % (RED, RESET, case["id"], elapsed, note_summary, cost))
            for p in problems[:8]:
                print("        %s%s%s" % (DIM, p, RESET))
            if len(problems) > 8:
                print("        %s... and %d more%s" % (DIM, len(problems) - 8, RESET))
        else:
            passed += 1
            print("%sPASS%s  %-28s %4.1fs  %s  cost %.2f"
                  % (GREEN, RESET, case["id"], elapsed, note_summary, cost))

        if args.verbose:
            for e in body.get("directive_interpretation", []):
                print("        %snote %s: %s %s - %s%s" % (
                    DIM, e.get("note_index"), e.get("directive_type"),
                    json.dumps(e.get("structured_adjustment")),
                    e.get("explanation", "")[:70], RESET))

    print("\n" + "-" * 60)
    print(" cases      : %d passed, %d failed, %d total" % (passed, failed, len(cases)))
    if notes_total:
        print(" notes      : %d/%d correct (%d%%)"
              % (notes_ok, notes_total, round(100 * notes_ok / notes_total)))
    print(" schedules  : %d/%d valid" % (valid, len(latencies)))
    if latencies:
        ordered = sorted(latencies)
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        band = "3/3" if p95 <= 5 else "2/3" if p95 <= 15 else "1/3" if p95 <= 30 else "0/3"
        print(" latency    : mean %.0fms  p95 %.0fms  -> %s latency points"
              % (1000 * sum(latencies) / len(latencies), 1000 * p95, band))
    print("-" * 60 + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
