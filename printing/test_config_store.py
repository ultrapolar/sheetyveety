"""Tests for config_store: the settings that back batch_print.py and the
settings GUI. Pure Python -- no display, no pypdf/reportlab needed.

Run with: py test_config_store.py
"""

import copy
import os
import sys
import tempfile

import config_store as cs


# --------------------------------------------------------------------------
# load / save round-trip
# --------------------------------------------------------------------------
def test_load_missing_file_returns_defaults():
    missing = os.path.join(tempfile.mkdtemp(), "does_not_exist.json")
    assert cs.load_config(missing) == cs.default_config()


def test_load_unparsable_file_falls_back_to_defaults():
    path = os.path.join(tempfile.mkdtemp(), "config.json")
    with open(path, "w") as f:
        f.write("{not valid json")
    assert cs.load_config(path) == cs.default_config()


def test_save_then_load_round_trips():
    path = os.path.join(tempfile.mkdtemp(), "config.json")
    config = cs.default_config()
    config["sheet"]["csv_url"] = "https://example.com/pub?output=csv"
    config["printers"]["ProvisionalBear"]["gap"] = 45
    cs.save_config(config, path)
    assert cs.load_config(path) == config


def test_save_is_atomic_no_tmp_left_behind():
    path = os.path.join(tempfile.mkdtemp(), "config.json")
    cs.save_config(cs.default_config(), path)
    assert os.path.exists(path)
    assert not os.path.exists(path + ".tmp")


def test_merge_fills_missing_keys_from_defaults():
    partial = {"sheet": {"csv_url": "https://example.com/x"}}
    merged = cs._merge(cs.DEFAULTS, partial)
    assert merged["sheet"]["csv_url"] == "https://example.com/x"
    assert merged["sheet"]["col_name"] == cs.DEFAULTS["sheet"]["col_name"]
    assert merged["printers"] == cs.DEFAULTS["printers"]


def test_merge_drops_unknown_keys():
    partial = {"sheet": {"csv_url": "x", "bogus_field": "nope"}, "made_up_section": {}}
    merged = cs._merge(cs.DEFAULTS, partial)
    assert "bogus_field" not in merged["sheet"]
    assert "made_up_section" not in merged


def test_merge_keeps_a_user_added_printer():
    """Regression: printers is a registry the user grows, not a fixed schema --
    a new printer name must survive being merged back onto the defaults."""
    config = cs.default_config()
    config["printers"]["LabelPrinter"] = {"duplex": True, "paced": False,
                                           "gap": 0, "batch": 0, "batch_pause": 0}
    merged = cs._merge(cs.DEFAULTS, config)
    assert "LabelPrinter" in merged["printers"]
    assert merged["printers"]["LabelPrinter"]["duplex"] is True


def test_save_then_load_keeps_a_new_printer():
    path = os.path.join(tempfile.mkdtemp(), "config.json")
    config = cs.default_config()
    config["printers"]["LabelPrinter"] = {"duplex": True, "paced": False,
                                           "gap": 0, "batch": 0, "batch_pause": 0}
    config["routing"]["assessment"] = "LabelPrinter"
    cs.save_config(config, path)
    reloaded = cs.load_config(path)
    assert "LabelPrinter" in reloaded["printers"]
    assert reloaded["routing"]["assessment"] == "LabelPrinter"


def test_merge_backfills_missing_fields_on_a_saved_printer():
    """A printer entry saved by an older version of this tool, missing a field
    added later, should get that field defaulted rather than crash flatten()."""
    partial = {"printers": {"OldPrinter": {"duplex": True}}}
    merged = cs._merge(cs.DEFAULTS, partial)
    assert merged["printers"]["OldPrinter"] == {
        "duplex": True, "paced": False, "gap": 0, "batch": 0, "batch_pause": 0,
    }


def test_merge_printers_ignores_blank_names():
    partial = {"printers": {"": {"duplex": True}, "  ": {"duplex": True}}}
    merged = cs._merge(cs.DEFAULTS, partial)
    assert merged["printers"] == {}


def test_default_config_is_a_fresh_copy_each_time():
    a, b = cs.default_config(), cs.default_config()
    a["sheet"]["csv_url"] = "changed"
    assert b["sheet"]["csv_url"] != "changed"


# --------------------------------------------------------------------------
# validate()
# --------------------------------------------------------------------------
def _valid_config():
    config = cs.default_config()
    config["sheet"]["csv_url"] = "https://docs.google.com/spreadsheets/d/abc/pub?output=csv"
    return config


def test_default_config_placeholder_url_fails_validation():
    problems = cs.validate(cs.default_config())
    assert any("placeholder" in p for p in problems)


def test_filled_in_config_validates_clean():
    assert cs.validate(_valid_config()) == []


def test_empty_csv_url_flagged():
    config = _valid_config()
    config["sheet"]["csv_url"] = "   "
    problems = cs.validate(config)
    assert any("Sheet CSV URL is empty" in p for p in problems)


def test_missing_column_headers_flagged():
    config = _valid_config()
    config["sheet"]["col_name"] = ""
    config["sheet"]["col_items"] = ""
    problems = cs.validate(config)
    assert any("Name column" in p for p in problems)
    assert any("Print-items column" in p for p in problems)


def test_no_printers_flagged():
    config = _valid_config()
    config["printers"] = {}
    problems = cs.validate(config)
    assert any("At least one printer" in p for p in problems)


def test_routing_to_undefined_printer_flagged():
    config = _valid_config()
    config["routing"]["deck"] = "NoSuchPrinter"
    problems = cs.validate(config)
    assert any("NoSuchPrinter" in p for p in problems)


def test_routing_missing_a_job_kind_flagged():
    config = _valid_config()
    del config["routing"]["supp"]
    problems = cs.validate(config)
    assert any("supp" in p for p in problems)


def test_paced_printer_needs_non_negative_pacing_fields():
    config = _valid_config()
    config["printers"]["ProvisionalBear"]["batch"] = 0
    problems = cs.validate(config)
    assert any("ProvisionalBear" in p and "batch" in p for p in problems)


def test_unpaced_printer_ignores_pacing_fields():
    config = _valid_config()
    config["printers"]["SMALLFATBEAR"]["gap"] = -5  # paced is False -> not checked
    assert cs.validate(config) == []


def test_page_caps_must_be_positive():
    config = _valid_config()
    config["temp"]["pages"] = 0
    config["supp"]["pages"] = -1
    problems = cs.validate(config)
    assert any("TEMP page cap" in p for p in problems)
    assert any("SUPP page cap" in p for p in problems)


def test_watermark_darkness_out_of_range_flagged():
    config = _valid_config()
    config["watermark_style"]["darkness"] = 1.5
    problems = cs.validate(config)
    assert any("darkness" in p for p in problems)


def test_print_scaling_must_be_a_known_value():
    config = _valid_config()
    config["print"]["settings"] = "stretch"
    problems = cs.validate(config)
    assert any("scaling" in p for p in problems)


# --------------------------------------------------------------------------
# flatten() -- must match what batch_print.py expects, and the shipped defaults
# --------------------------------------------------------------------------
def test_flatten_default_matches_original_hardcoded_values():
    flat = cs.flatten(cs.default_config())
    assert flat["PRINTERS"] == {
        "deck": "ProvisionalBear", "lp": "ProvisionalBear", "temp": "ProvisionalBear",
        "supp": "ProvisionalBear", "assessment": "SMALLFATBEAR",
    }
    assert flat["DUPLEX_PRINTERS"] == {"SMALLFATBEAR"}
    assert flat["SPACING"] == {"ProvisionalBear": {"gap": 30, "batch": 4, "batch_pause": 60}}
    assert "SMALLFATBEAR" not in flat["SPACING"]
    assert flat["TEMP_PAGES"] == 20
    assert flat["SUPP_PAGES"] == 15
    assert flat["SUPP_WATERMARK"] == "WOB"
    assert flat["WM_DARKNESS"] == 0.15


def test_flatten_reflects_edited_routing():
    config = cs.default_config()
    config["printers"]["ThirdPrinter"] = {"duplex": True, "paced": False,
                                           "gap": 0, "batch": 0, "batch_pause": 0}
    config["routing"]["assessment"] = "ThirdPrinter"
    flat = cs.flatten(config)
    assert flat["PRINTERS"]["assessment"] == "ThirdPrinter"
    assert "ThirdPrinter" in flat["DUPLEX_PRINTERS"]


def test_flatten_omits_unpaced_printer_from_spacing():
    config = cs.default_config()
    config["printers"]["ProvisionalBear"]["paced"] = False
    flat = cs.flatten(config)
    assert flat["SPACING"] == {}


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
