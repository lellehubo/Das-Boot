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
# The summer table runs Monday-Friday as one type; the autumn table splits Friday
# out, so the set of day types differs between editions.
DAY_HEADINGS = {
    "Måndag–fredag": "vardag",
    "Måndag–torsdag": "mtor",
    "Fredag": "fre",
    "Lördag,": "helg",
}

DIRECTION_HEADINGS = {"Nybroplan–Ropsten": "ropsten", "Ropsten–Nybroplan": "nybroplan"}

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


def page_directions(document):
    """Group pages by direction. Editions differ in page count (summer 7, autumn 9)
    and the Ropsten-Storholmen shuttle at the end is not part of this app."""
    groups = {}
    for index in range(document.page_count):
        text = document[index].get_text()
        for heading, key in DIRECTION_HEADINGS.items():
            if heading in text:
                groups.setdefault(key, []).append(index)
                break
    return groups


def extract(document, pages, warnings):
    """Collect Saltsjoqvarn departures per day type across a run of pages.

    A heading applies downwards until the next one. A block with no heading above
    it continues the previous page ("Fortsattning fran foregande sida").
    """
    result = {}
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
            result.setdefault(day_type, []).extend(read_row(words, row_y, warnings))

        if headings:
            carried = headings[-1][1]

    return result


def check(times, label, warnings):
    if times != sorted(times):
        warnings.append(f"{label}: not chronological")
    if len(times) != len(set(times)):
        warnings.append(f"{label}: contains duplicates")


# Boat legs the "Jobbet" scenarios need, per direction, as
# (board table name, alight table name, board node id, alight node id).
#
# Both commute directions are covered. Going to work the boat is boarded at
# Saltsjoqvarn; coming home it is boarded at Allmanna grand or Frihamnen and left
# at Saltsjoqvarn. Which sailing direction a pair belongs to follows from the pier
# order: Allmanna grand lies west of Saltsjoqvarn, Frihamnen east of it.
LEG_PAIRS = {
    "ropsten": [
        ("Saltsjöqvarn", "Frihamnen", "saltsjoqvarn", "frihamnen_pier"),
        ("Allmänna", "Saltsjöqvarn", "allmanna_grand", "saltsjoqvarn"),
    ],
    "nybroplan": [
        ("Saltsjöqvarn", "Allmänna", "saltsjoqvarn", "allmanna_grand"),
        ("Frihamnen", "Saltsjöqvarn", "frihamnen_pier", "saltsjoqvarn"),
    ],
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


def extract_legs(document, pages, pairs, warnings):
    """Map each printed departure to its arrival, for every board/alight pair.

    Result shape: {day_type: {board_node: {departure: {alight_node: arrival}}}}
    """
    result = {}
    carried = None

    for index in pages:
        words = document[index].get_text("words")
        headings = sorted(
            (y0, DAY_HEADINGS[text])
            for _x0, y0, _x1, _y1, text, *_ in words
            if text in DAY_HEADINGS
        )
        # Day type is anchored on Saltsjoqvarn's rows, which every block has.
        anchor_rows = rows_for(words, ORIGIN)
        day_types = []
        for anchor_y in anchor_rows:
            above = [key for heading_y, key in headings if heading_y < anchor_y]
            day_types.append(above[-1] if above else carried)
            if day_types[-1] is not None:
                carried = day_types[-1]

        for board_name, alight_name, board_node, alight_node in pairs:
            board_rows = rows_for(words, board_name)
            alight_rows = rows_for(words, alight_name)

            for block, day_type in enumerate(day_types):
                if day_type is None:
                    continue
                if block >= len(board_rows) or block >= len(alight_rows):
                    warnings.append(
                        f"page {index + 1}: missing {board_name}/{alight_name} row for block {block}"
                    )
                    continue

                departures = row_cells(words, board_rows[block])
                arrivals = row_cells(words, alight_rows[block])
                for x, departure in departures.items():
                    match = [
                        arrivals[ax] for ax in arrivals if abs(ax - x) < COLUMN_TOLERANCE
                    ]
                    if not match:
                        continue
                    # A negative difference means the boat called at the alight
                    # stop first, so this run travels the other way.
                    if (to_minutes(match[0]) - to_minutes(departure)) % 1440 > 720:
                        continue
                    (
                        result.setdefault(day_type, {})
                        .setdefault(board_node, {})
                        .setdefault(departure, {})
                    )[alight_node] = match[0]

        if headings:
            carried = headings[-1][1]

    return result


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    legs_mode = "--legs" in sys.argv[2:]

    document = fitz.open(sys.argv[1])
    warnings = []

    PAGES = page_directions(document)
    for direction in ("ropsten", "nybroplan"):
        if direction not in PAGES:
            sys.exit(f"no pages found for direction {direction}")

    if legs_mode:
        output = {
            direction: extract_legs(document, pages, LEG_PAIRS[direction], warnings)
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
