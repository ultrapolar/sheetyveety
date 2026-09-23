"""Detect printers Windows already knows about, so Batch Print Settings can
offer them as a pick-list instead of requiring an exact typed printer name.

This is NOT a network scan for devices nobody's set up yet. SumatraPDF prints
by handing Windows a printer NAME (`-print-to <name>`); it has no way to
target a raw IP or discover a device on its own. So "every printer on the
network" in a way that's actually usable here means every printer Windows
itself has a name for -- local, shared over SMB from another PC, or an IP/
network printer someone already added via Settings > Printers. A new device
still needs to be added in Windows once (Settings > Bluetooth & devices >
Printers > Add device) before it can show up here; after that, Detect finds
it without anyone typing its exact name into this tool.

Kept dependency-light and importable on any platform: the win32print import
only happens inside list_windows_printers(), so settings_gui.py can import
this module freely and just disable/explain the Detect button when it's not
usable on the current machine.
"""

import sys


class PrinterDiscoveryUnavailable(Exception):
    """Detection can't be attempted here. str(e) is a human-readable reason,
    safe to show directly in a messagebox."""


def list_windows_printers():
    """Sorted, deduplicated names of every printer Windows knows about
    (local, shared, or an installed network/IP printer).

    Raises PrinterDiscoveryUnavailable with a plain-English reason if this
    isn't a Windows machine, pywin32 isn't installed, or Windows itself
    couldn't be asked (e.g. the Print Spooler service isn't running).
    """
    if sys.platform != "win32":
        raise PrinterDiscoveryUnavailable(
            "Printer detection only works on Windows -- this isn't a Windows PC.")
    try:
        import win32print
    except ImportError:
        raise PrinterDiscoveryUnavailable(
            "Printer detection needs the pywin32 package, which isn't installed.\n"
            "Install it with:\n  py -m pip install pywin32\n"
            "or add a printer's exact name by hand below.")

    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    try:
        printers = win32print.EnumPrinters(flags)
    except Exception as e:
        raise PrinterDiscoveryUnavailable(f"Windows would not list printers: {e}")

    # EnumPrinters returns tuples of (Flags, pDescription, pName, pComment).
    names = {entry[2] for entry in printers if entry[2]}
    return sorted(names)
