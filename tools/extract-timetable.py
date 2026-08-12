#!/usr/bin/env python3
"""Extract boat line 80 times for Saltsjoqvarn from an SL timetable PDF.

SL publishes line 80 as a printable PDF (e.g. kund.printhuset-sthlm.se/sl/h80.pdf).

Usage:
    python tools/extract-timetable.py h80.pdf            > tt.json
    python tools/extract-timetable.py h80.pdf --legs     > boat-legs.json

Default output is the TT object used by index.html: departure times per direction
and day type.

--legs pairs each departure with its arrival at the stops the "Jobbet" scenarios
need. SL Transport's /departures caps at roughly six departures per stop, so for a
38-minute leg the origin and destination windows barely overlap and journey ids
cannot be matched across them. Arrival therefore comes from the table; realtime
only adjusts the departure.

Requires pymupdf.

Two things about the PDF make naive text extraction wrong:

1. Recurring traffic is compressed. Instead of listing every departure the table
   prints a rule ("Fran kl 10.30 var 30:e minut till kl 14.00") plus two to four
   sample columns that show only the minute digits. Those samples are what carry
   the interval, so the step is derived from them rather than from the rule text.

2. Express runs skip stops, leaving glyph placeholders in the row. A compressed
   region is therefore not guaranteed to line up with the next printed departure
   (17:27 + 30 min steps never lands on 20:02), so expansion stops short instead
   of requiring the gap to divide evenly.
"""

import json
import re
import sys

import fitz  # pymupdf

FULL = re.compile(r"^([01]\d|2[0-3])\.([0-5]\d)$")
FRAGMENT = re.compile(r"^([0-5]\d)$")

# Day-type headings. "Lordag," is the first word of "Lordag, sondag och helgdag".
DAY_HEADINGS = {"Måndag–torsdag": "mtor", "Fredag": "fre", "Lördag,": "helg"}

ORIGIN = "Saltsjöqvarn"
NAME_COLUMN_MAX_X = 100  # stop names sit at x=54; timetable columns start at x>120
ROW_TOLERANCE = 3  # points; rows are ~10pt apart


def to_minutes(value):
    hours, minutes = re.split(r"[:.]", value)
    return int(hours) * 60 + int(minutes)


def to_clock(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def expand(previous, following, samples, warnings):
    """Expand a compressed region between two printed departures.

    `samples` are the minute-only cells; consecutive differences give the step.
    """
    steps = {(samples[i + 1] - samples[i]) % 60 for i in range(len(samples) - 1)}
    if len(steps) != 1:
        warnings.append(f"uneven sample spacing {samples} before {following}")
        return []
    step = steps.pop()
    if step == 0:
        warnings.append(f"zero step from samples {samples} before {following}")
        return []

    start = to_minutes(previous)
    gap = (to_minutes(following) - start) % 1440
    expanded = [to_clock((start + k) % 1440) for k in range(step, gap, step)]

    unexpected = [t for t in expanded if int(t[3:]) not in samples]
    if unexpected:
        warnings.append(
            f"expanded {previous}->{following} produced minutes outside "
            f"samples {samples}: {unexpected[:4]}"
        )
    return expanded


def read_row(words, row_y, warnings):
    """Read one stop's row, expanding compressed regions as they are encountered."""
    cells = sorted(
        ((x0, text) for x0, y0, _x1, _y1, text, *_ in words if abs(y0 - row_y) < ROW_TOLERANCE),
        key=lambda cell: cell[0],
    )

    times = []
    samples = []
    for _x, text in cells:
        if FULL.match(text):
            current = text.replace(".", ":")
            if samples and times:
                times += expand(times[-1], current, samples, warnings)
            samples = []
            times.append(current)
        elif FRAGMENT.match(text):
            samples.append(int(text))
    return times


def extract(document, pages, warnings):
    """Collect Saltsjoqvarn departures per day type across a run of pages.

    A heading applies downwards until the next one. A block with no heading above
    it continues the previous page ("Fortsattning fran foregande sida").
    """
    result = {"mtor": [], "fre": [], "helg": []}
    carried = None

    for index in pages:
        words = document[index].get_text("words")
        headings = sorted(
            (y0, DAY_HEADINGS[text])
            for _x0, y0, _x1, _y1, text, *_ in words
            if text in DAY_HEADINGS
        )
        rows = sorted(
            y0
            for x0, y0, _x1, _y1, text, *_ in words
            if text == ORIGIN and x0 < NAME_COLUMN_MAX_X
        )

        for row_y in rows:
            above = [key for heading_y, key in headings if heading_y < row_y]
            day_type = above[-1] if above else carried
            if day_type is None:
                warnings.append(f"page {index + 1}: row at y={row_y:.0f} has no day type")
                continue
            carried = day_type
            result[day_type] += read_row(words, row_y, warnings)

        if headings:
            carried = headings[-1][1]

    return result


def check(times, label, warnings):
    if times != sorted(times):
        warnings.append(f"{label}: not chronological")
    if len(times) != len(set(times)):
        warnings.append(f"{label}: contains duplicates")


# Stops the "Jobbet" scenarios board or leave the boat at, by table name.
LEG_TARGETS = {
    "ropsten": {"Frihamnen": "frihamnen_pier"},
    "nybroplan": {"Allmänna": "allmanna_grand"},
}

COLUMN_TOLERANCE = 6  # points; a column's cells share an x within this


def row_cells(words, row_y):
    """Printed times on one row, keyed by column x. Compressed cells are skipped:
    a sample column carries no hour, so it cannot be paired with an arrival."""
    return {
        round(x0): text.replace(".", ":")
        for x0, y0, _x1, _y1, text, *_ in words
        if abs(y0 - row_y) < ROW_TOLERANCE and FULL.match(text)
    }


def rows_for(words, stop_name):
    return sorted(
        y0
        for x0, y0, _x1, _y1, text, *_ in words
        if text == stop_name and x0 < NAME_COLUMN_MAX_X
    )


def extract_legs(document, pages, targets, warnings):
    """Map each printed departure to its arrival at each target stop."""
    result = {"mtor": {}, "fre": {}, "helg": {}}
    carried = None

    for index in pages:
        words = document[index].get_text("words")
        headings = sorted(
            (y0, DAY_HEADINGS[text])
            for _x0, y0, _x1, _y1, text, *_ in words
            if text in DAY_HEADINGS
        )
        origin_rows = rows_for(words, ORIGIN)
        target_rows = {name: rows_for(words, name) for name in targets}

        for block, origin_y in enumerate(origin_rows):
            above = [key for heading_y, key in headings if heading_y < origin_y]
            day_type = above[-1] if above else carried
            if day_type is None:
                continue
            carried = day_type

            departures = row_cells(words, origin_y)
            for name, node in targets.items():
                if block >= len(target_rows[name]):
                    warnings.append(f"page {index + 1}: no {name} row for block {block}")
                    continue
                arrivals = row_cells(words, target_rows[name][block])
                for x, departure in departures.items():
                    match = [
                        arrivals[ax] for ax in arrivals if abs(ax - x) < COLUMN_TOLERANCE
                    ]
                    if not match:
                        continue
                    # A negative difference means the boat called at the target
                    # before Saltsjoqvarn, i.e. this run goes the other way.
                    if (to_minutes(match[0]) - to_minutes(departure)) % 1440 > 720:
                        continue
                    result[day_type].setdefault(departure, {})[node] = match[0]

        if headings:
            carried = headings[-1][1]

    return result


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    legs_mode = "--legs" in sys.argv[2:]

    document = fitz.open(sys.argv[1])
    warnings = []

    # Pages 1-4 are Nybroplan->Ropsten (eastbound), 5-8 Ropsten->Nybroplan.
    # Page 9 is the Ropsten-Storholmen shuttle and is not part of this app.
    PAGES = {"ropsten": range(0, 4), "nybroplan": range(4, 8)}

    if legs_mode:
        output = {
            direction: extract_legs(document, pages, LEG_TARGETS[direction], warnings)
            for direction, pages in PAGES.items()
        }
    else:
        output = {
            direction: extract(document, pages, warnings)
            for direction, pages in PAGES.items()
        }
        for direction, day_types in output.items():
            for day_type, times in day_types.items():
                check(times, f"{direction}/{day_type}", warnings)

    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)

    json.dump(output, sys.stdout, ensure_ascii=False, indent=1)
    print(file=sys.stdout)


if __name__ == "__main__":
    main()
