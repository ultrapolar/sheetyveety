"""Tests for printer_discovery: listing printers Windows already knows about
for the Settings GUI's "Detect printers on this PC" button.

Runs anywhere, without a Windows machine or pywin32 installed -- sys.platform
and sys.modules['win32print'] are patched by hand and restored after each
test, matching the style used elsewhere in this suite (no pytest fixtures).
"""

import sys
import types

import printer_discovery as pd


def _run_as(platform, win32print_module, fn):
    """Run fn() with sys.platform and sys.modules['win32print'] overridden,
    then restore both -- even if fn() raises."""
    real_platform = sys.platform
    real_modules = dict(sys.modules)
    sys.platform = platform
    if win32print_module is not None:
        sys.modules["win32print"] = win32print_module
    else:
        sys.modules.pop("win32print", None)
    try:
        fn()
    finally:
        sys.platform = real_platform
        sys.modules.clear()
        sys.modules.update(real_modules)


def _fake_win32print(enum_printers):
    mod = types.ModuleType("win32print")
    mod.PRINTER_ENUM_LOCAL = 2
    mod.PRINTER_ENUM_CONNECTIONS = 4
    mod.EnumPrinters = enum_printers
    return mod


# --------------------------------------------------------------------------
def test_non_windows_raises_with_a_clear_reason():
    def run():
        try:
            pd.list_windows_printers()
            assert False, "expected PrinterDiscoveryUnavailable"
        except pd.PrinterDiscoveryUnavailable as e:
            assert "Windows" in str(e)
    _run_as("linux", None, run)


def test_missing_pywin32_raises_with_install_instructions():
    # sys.modules['win32print'] = None makes `import win32print` raise
    # ImportError even if pywin32 happens to be installed in this env.
    def run():
        real = sys.modules.get("win32print")
        sys.modules["win32print"] = None
        try:
            try:
                pd.list_windows_printers()
                assert False, "expected PrinterDiscoveryUnavailable"
            except pd.PrinterDiscoveryUnavailable as e:
                assert "pywin32" in str(e)
        finally:
            if real is not None:
                sys.modules["win32print"] = real
            else:
                sys.modules.pop("win32print", None)
    _run_as("win32", None, run)


def test_lists_and_dedupes_printer_names():
    fake = _fake_win32print(lambda flags: [
        (0, "", "ProvisionalBear", ""),
        (0, "", "SMALLFATBEAR", ""),
        (0, "", "ProvisionalBear", ""),   # e.g. a local entry AND a connection entry
        (0, "", "", ""),                  # a blank name must be dropped, not kept
    ])
    def run():
        assert pd.list_windows_printers() == ["ProvisionalBear", "SMALLFATBEAR"]
    _run_as("win32", fake, run)


def test_no_printers_returns_empty_list_not_an_error():
    fake = _fake_win32print(lambda flags: [])
    def run():
        assert pd.list_windows_printers() == []
    _run_as("win32", fake, run)


def test_enum_failure_is_wrapped_with_a_clear_reason():
    def boom(flags):
        raise OSError("spooler service not running")
    fake = _fake_win32print(boom)
    def run():
        try:
            pd.list_windows_printers()
            assert False, "expected PrinterDiscoveryUnavailable"
        except pd.PrinterDiscoveryUnavailable as e:
            assert "spooler" in str(e)
    _run_as("win32", fake, run)


def test_queries_both_local_and_network_connections():
    seen = {}
    def enum_printers(flags):
        seen["flags"] = flags
        return []
    fake = _fake_win32print(enum_printers)
    def run():
        pd.list_windows_printers()
        assert seen["flags"] == fake.PRINTER_ENUM_LOCAL | fake.PRINTER_ENUM_CONNECTIONS
    _run_as("win32", fake, run)


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
