"""
Tests for batch_print.

No printer and no \\newcloud needed: each test builds a fake share tree in a temp
folder and points batch_print.BASE at it. Run with:

    py -m pytest test_batch_print.py -v      (or just: py test_batch_print.py)
"""

import os
import subprocess
import sys
import tempfile

import batch_print as bp

DECK = "Upcoming Decks"
ASSESS = "Assessments"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def share(*files):
    """Build a fake share tree. Each file is (student, subfolder, filename)."""
    root = tempfile.mkdtemp(prefix="fakeshare_")
    for student, sub, fname in files:
        d = os.path.join(root, f"+{student}", sub)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, fname), "w").close()
    bp.BASE = root
    return root


def never_ask(*a, **k):
    raise AssertionError("should not have prompted the user")


def answer(n):
    return lambda *a, **k: n


def names(jobs):
    return [os.path.basename(j["path"]) for j in jobs]


# --------------------------------------------------------------------------
# filename matching
# --------------------------------------------------------------------------
def test_sd_matches_space_convention():
    share(("Jane Smith", DECK, "Jane Smith SD12 20240115.pdf"))
    ready, deferred, _ = bp.build_queue([{"Name": "Jane Smith", "Print": "SD12"}])
    assert names(ready) == ["Jane Smith SD12 20240115.pdf"]
    assert ready[0]["watermark"] == "SD12"
    assert not deferred


def test_sd3_does_not_collide_with_sd33():
    share(("Jane Smith", DECK, "Jane Smith SD3 20240101.pdf"),
          ("Jane Smith", DECK, "Jane Smith SD33 20240101.pdf"))
    ready, _, _ = bp.build_queue([{"Name": "Jane Smith", "Print": "SD3"}])
    assert names(ready) == ["Jane Smith SD3 20240101.pdf"]


def test_sd_defers_when_two_dates_match():
    share(("Bob Roe", DECK, "Bob Roe SD2 20240101.pdf"),
          ("Bob Roe", DECK, "Bob Roe SD2 20240202.pdf"))
    ready, deferred, _ = bp.build_queue([{"Name": "Bob Roe", "Print": "SD2"}])
    assert not ready
    assert "ambiguous" in deferred[0][2]


def test_missing_file_defers():
    share(("Tim Ng", DECK, "Tim Ng SD1 20240101.pdf"))
    _, deferred, _ = bp.build_queue([{"Name": "Tim Ng", "Print": "SD9"}])
    assert "no file found" in deferred[0][2]


def test_lp_uses_underscore_convention_and_newest_date_wins():
    share(("Amalie Laz", DECK, "Amalie Laz_LP 1 of 3_2026-07-30.pdf"),
          ("Amalie Laz", DECK, "Amalie Laz_LP 1 of 3_2025-09-23.pdf"))
    ready, deferred, _ = bp.build_queue([{"Name": "Amalie Laz", "Print": "LP 1 of 3"}])
    assert names(ready) == ["Amalie Laz_LP 1 of 3_2026-07-30.pdf"]
    assert ready[0]["watermark"] == ""      # LP is never watermarked
    assert not deferred


def test_lp_tolerates_whitespace_typo_even_when_newest():
    """'LP 1 of3' must still be found, or a typo'd newest file prints an older one."""
    share(("Bo Ng", DECK, "Bo Ng_LP 1 of 3_2025-01-01.pdf"),
          ("Bo Ng", DECK, "Bo Ng_LP 1 of3_2026-11-11.pdf"))
    ready, _, _ = bp.build_queue([{"Name": "Bo Ng", "Print": "LP 1 of 3"}])
    assert names(ready) == ["Bo Ng_LP 1 of3_2026-11-11.pdf"]


def test_lp_1_of_n_works_for_n_up_to_5():
    for n in range(1, 6):
        who = f"Stu{n}"
        share((who, DECK, f"{who}_LP 1 of {n}_2026-07-30.pdf"))
        ready, deferred, _ = bp.build_queue([{"Name": who, "Print": f"LP 1 of {n}"}])
        assert len(ready) == 1 and not deferred, n


def test_assessment_routes_to_assessments_folder():
    share(("John Doe", ASSESS, "John Doe Diagnostic 20240101.pdf"))
    ready, _, _ = bp.build_queue([{"Name": "John Doe", "Print": "Diagnostic"}])
    assert ready[0]["kind"] == "assessment"
    assert ready[0]["watermark"] == ""


def test_temp_takes_newest_and_caps_pages():
    share(("Amy Lee", DECK, "Amy Lee TEMP 20240101.pdf"),
          ("Amy Lee", DECK, "Amy Lee TEMP 20240305.pdf"))
    ready, _, _ = bp.build_queue([{"Name": "Amy Lee", "Print": "TEMP"}])
    assert names(ready) == ["Amy Lee TEMP 20240305.pdf"]
    assert ready[0]["max_pages"] == bp.TEMP_PAGES


# --------------------------------------------------------------------------
# SUPP companion
# --------------------------------------------------------------------------
def test_supp_pairs_by_exact_date():
    share(("Amalie Laz", DECK, "Amalie Laz_LP 1 of 3_2026-07-30.pdf"),
          ("Amalie Laz", DECK, "Amalie Laz_SUPP_2026-07-30.pdf"),
          ("Amalie Laz", DECK, "Amalie Laz_SUPP_2025-09-23.pdf"))
    ready, _, warnings = bp.build_queue([{"Name": "Amalie Laz", "Print": "LP 1 of 3"}])
    assert [j["kind"] for j in ready] == ["lp", "supp"]
    assert names(ready)[1] == "Amalie Laz_SUPP_2026-07-30.pdf"
    assert ready[1]["watermark"] == "WOB"
    assert ready[1]["max_pages"] == 15
    assert not warnings


def test_missing_supp_warns_but_still_prints_the_lp():
    share(("Bo Ng", DECK, "Bo Ng_LP 1 of 2_2026-05-05.pdf"),
          ("Bo Ng", DECK, "Bo Ng_SUPP_2024-01-01.pdf"))     # wrong date
    ready, deferred, warnings = bp.build_queue([{"Name": "Bo Ng", "Print": "LP 1 of 2"}])
    assert [j["kind"] for j in ready] == ["lp"]
    assert len(warnings) == 1 and "2026-05-05" in warnings[0]
    assert not deferred          # a missing SUPP must never block


def test_only_first_lp_pulls_a_supp():
    share(("Cy Vu", DECK, "Cy Vu_LP 2 of 3_2026-03-03.pdf"),
          ("Cy Vu", DECK, "Cy Vu_SUPP_2026-03-03.pdf"))
    ready, _, warnings = bp.build_queue([{"Name": "Cy Vu", "Print": "LP 2 of 3"}])
    assert [j["kind"] for j in ready] == ["lp"]
    assert not warnings


# --------------------------------------------------------------------------
# which items in a row get printed
# --------------------------------------------------------------------------
def test_two_decks_collapse_to_the_first():
    assert bp.plan_row("X", ["SD12", "SD13", "2nd PCAR"], never_ask) == ["SD12"]
    assert bp.plan_row("X", ["SD12", "SD14"], never_ask) == ["SD12"]
    assert bp.plan_row("X", ["LP 1 of 5", "LP 2 of 5", "CUA1"], never_ask) == ["LP 1 of 5"]
    assert bp.plan_row("X", ["LP 1 of 3", "SD12"], never_ask) == ["LP 1 of 3"]


def test_deck_alone_or_with_one_other_prints_without_asking():
    assert bp.plan_row("X", ["SD12"], never_ask) == ["SD12"]
    assert bp.plan_row("X", ["SD12", "2nd PCAR"], never_ask) == ["SD12", "2nd PCAR"]


def test_single_non_deck_item_prints_without_asking():
    assert bp.plan_row("X", ["2nd PCAR"], never_ask) == ["2nd PCAR"]


def test_deck_plus_several_asks():
    items = ["SD12", "2nd PCAR", "CUA1"]
    assert bp.plan_row("X", items, answer(2)) == ["SD12", "2nd PCAR"]


def test_several_items_no_deck_asks():
    items = ["2nd PCAR", "CUA1"]
    assert bp.plan_row("X", items, answer(1)) == ["2nd PCAR"]


def test_temp_is_not_a_deck():
    assert bp.plan_row("X", ["TEMP", "SD1"], never_ask) == ["TEMP", "SD1"]


def test_blank_name_and_blank_items_defer():
    share(("X", DECK, "X SD1 20240101.pdf"))
    _, deferred, _ = bp.build_queue([{"Name": "", "Print": "SD1"},
                                     {"Name": "Kim Park", "Print": ""}])
    reasons = [d[2] for d in deferred]
    assert "no name" in reasons and "no item to print" in reasons


# --------------------------------------------------------------------------
# routing / printers
# --------------------------------------------------------------------------
def test_printer_routing():
    assert bp.PRINTERS["deck"] == "ProvisionalBear"
    assert bp.PRINTERS["lp"] == "ProvisionalBear"
    assert bp.PRINTERS["temp"] == "ProvisionalBear"
    assert bp.PRINTERS["supp"] == "ProvisionalBear"
    assert bp.PRINTERS["assessment"] == "SMALLFATBEAR"


def test_duplex_only_on_smallfatbear(monkeypatch=None):
    seen = {}
    real = bp.subprocess.run
    bp.subprocess.run = lambda cmd, **k: seen.__setitem__("cmd", cmd)
    try:
        bp.print_pdf("a.pdf", "SMALLFATBEAR")
        assert "duplexlong" in " ".join(seen["cmd"])
        bp.print_pdf("a.pdf", "ProvisionalBear")
        assert "duplexlong" not in " ".join(seen["cmd"])
    finally:
        bp.subprocess.run = real


def test_hang_does_not_kill_the_batch():
    real = bp.subprocess.run
    def hang(cmd, **k):
        raise subprocess.TimeoutExpired(cmd, bp.PRINT_TIMEOUT)
    bp.subprocess.run = hang
    try:
        bp.print_pdf("stuck.pdf", "ProvisionalBear")   # must not raise
    finally:
        bp.subprocess.run = real


def test_provisionalbear_is_paced_and_smallfatbear_is_not():
    assert "ProvisionalBear" in bp.SPACING
    assert "SMALLFATBEAR" not in bp.SPACING
    cfg = bp.SPACING["ProvisionalBear"]
    assert cfg["gap"] == 30 and cfg["batch"] == 4 and cfg["batch_pause"] == 60


# --------------------------------------------------------------------------
# watermarking / page slicing
# --------------------------------------------------------------------------
def _make_pdf(path, pages):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter
    c = canvas.Canvas(path, pagesize=letter)
    for i in range(pages):
        c.drawString(72, 720, f"page {i+1}")
        c.showPage()
    c.save()


def test_page_slicing_and_short_docs():
    from pypdf import PdfReader
    d = tempfile.mkdtemp()
    src = os.path.join(d, "src.pdf")
    _make_pdf(src, 25)
    out = os.path.join(d, "out.pdf")
    bp.build_temp(src, out, "", 20)
    assert len(PdfReader(out).pages) == 20
    short = os.path.join(d, "short.pdf")
    _make_pdf(short, 5)
    bp.build_temp(short, out, "", 20)
    assert len(PdfReader(out).pages) == 5      # cap must not error on short docs


def test_watermark_darkness_is_15_percent():
    """Rasterize and check the darkest pixel. 15% black over white = 217."""
    try:
        import fitz
    except ImportError:
        return      # pymupdf optional; skip if absent
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter
    d = tempfile.mkdtemp()
    blank, out = os.path.join(d, "b.pdf"), os.path.join(d, "w.pdf")
    # a TRULY blank page -- any body text would be solid black and would be
    # measured as "darkest pixel" instead of the watermark
    c = canvas.Canvas(blank, pagesize=letter)
    c.showPage()
    c.save()
    r, w = PdfReader(blank), PdfWriter()
    for p in r.pages:
        p.merge_page(bp._overlay(float(p.mediabox.width), float(p.mediabox.height), "SD12"))
        w.add_page(p)
    with open(out, "wb") as f:
        w.write(f)
    pix = fitz.open(out)[0].get_pixmap(dpi=150)
    if pix.n >= 4:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    data, n = pix.samples, pix.n
    darkest = min(min(data[i], data[i+1], data[i+2]) for i in range(0, len(data), n))
    assert abs(darkest - round(255 * (1 - bp.WM_DARKNESS))) <= 8


def test_originals_are_never_modified():
    d = tempfile.mkdtemp()
    src = os.path.join(d, "src.pdf")
    _make_pdf(src, 3)
    before = open(src, "rb").read()
    bp.build_temp(src, os.path.join(d, "out.pdf"), "WOB", 2)
    assert open(src, "rb").read() == before


# --------------------------------------------------------------------------
if __name__ == "__main__":
    fns = [(k, v) for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for name, fn in fns:
        try:
            fn()
            print(f"  PASS  {name}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {name}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
