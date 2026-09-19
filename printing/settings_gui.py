"""Batch Print Settings -- a small Tkinter editor for config.json.

Lets whoever is running Batch Print change the Google Sheet, the printers
and their protocols (duplex, pacing), which job kind goes to which printer,
watermarks, and the few other knobs -- without opening batch_print.py or
touching JSON by hand.

Run directly (double-click, or the "Batch Print Settings" shortcut), or via
`python batch_print.py --settings`.
"""

import tkinter as tk
from tkinter import messagebox, ttk

from config_store import JOB_KINDS, load_config, save_config, validate

JOB_LABELS = {
    "deck": "Decks (SD##)",
    "lp": "Lesson plans (LP # of #)",
    "temp": "TEMP",
    "supp": "SUPP (LP's companion)",
    "assessment": "Everything else (assessments)",
}


class PrinterRow(ttk.Frame):
    """One printer's protocol: its name, duplex, and pacing."""

    def __init__(self, parent, on_change, on_rename, name="", duplex=False, paced=False,
                 gap=30, batch=4, batch_pause=60):
        super().__init__(parent)
        self.on_change = on_change
        self.on_rename = on_rename
        self._prev_name = name.strip()

        self.name_var = tk.StringVar(value=name)
        self.duplex_var = tk.BooleanVar(value=duplex)
        self.paced_var = tk.BooleanVar(value=paced)
        self.gap_var = tk.StringVar(value=str(gap))
        self.batch_var = tk.StringVar(value=str(batch))
        self.batch_pause_var = tk.StringVar(value=str(batch_pause))

        ttk.Entry(self, textvariable=self.name_var, width=18).grid(row=0, column=0, padx=2)
        ttk.Checkbutton(self, text="Duplex", variable=self.duplex_var,
                         command=self._changed).grid(row=0, column=1, padx=6)
        ttk.Checkbutton(self, text="Paced", variable=self.paced_var,
                         command=self._toggle_pacing).grid(row=0, column=2, padx=6)

        ttk.Label(self, text="gap(s)").grid(row=0, column=3, sticky="e")
        self.gap_entry = ttk.Entry(self, textvariable=self.gap_var, width=5)
        self.gap_entry.grid(row=0, column=4, padx=2)

        ttk.Label(self, text="every").grid(row=0, column=5, sticky="e")
        self.batch_entry = ttk.Entry(self, textvariable=self.batch_var, width=4)
        self.batch_entry.grid(row=0, column=6, padx=2)

        ttk.Label(self, text="rest(s)").grid(row=0, column=7, sticky="e")
        self.batch_pause_entry = ttk.Entry(self, textvariable=self.batch_pause_var, width=5)
        self.batch_pause_entry.grid(row=0, column=8, padx=2)

        self.remove_btn = ttk.Button(self, text="Remove", command=self._remove)
        self.remove_btn.grid(row=0, column=9, padx=(10, 0))

        self.name_var.trace_add("write", lambda *_: self._name_changed())
        self._toggle_pacing()

    def _toggle_pacing(self):
        state = "normal" if self.paced_var.get() else "disabled"
        for widget in (self.gap_entry, self.batch_entry, self.batch_pause_entry):
            widget.configure(state=state)
        self._changed()

    def _changed(self):
        self.on_change()

    def _name_changed(self):
        new = self.name_var.get().strip()
        old = self._prev_name
        self._prev_name = new
        # A rename should carry its routing along -- it's the same physical
        # printer under a new label, not a delete-and-recreate. Only a real
        # removal should leave routing pointing at a name that no longer
        # exists (validate() catches that on Save).
        if old and new and old != new:
            self.on_rename(old, new)
        else:
            self.on_change()

    def _remove(self):
        self.destroy()
        self.on_change()

    def to_dict(self):
        return {
            "name": self.name_var.get().strip(),
            "duplex": bool(self.duplex_var.get()),
            "paced": bool(self.paced_var.get()),
            "gap": self.gap_var.get().strip(),
            "batch": self.batch_var.get().strip(),
            "batch_pause": self.batch_pause_var.get().strip(),
        }


def _labeled_entry(parent, row, label, var, width=60):
    ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=4, pady=3)
    entry = ttk.Entry(parent, textvariable=var, width=width)
    entry.grid(row=row, column=1, sticky="we", padx=4, pady=3)
    return entry


class SettingsApp(ttk.Frame):
    def __init__(self, root, initial_config=None):
        super().__init__(root)
        self.root = root
        self.config = initial_config if initial_config is not None else load_config()
        self.printer_rows = []

        notebook = ttk.Notebook(self)
        notebook.pack(fill="both", expand=True, padx=8, pady=8)

        self.sheet_tab = ttk.Frame(notebook, padding=10)
        self.printers_tab = ttk.Frame(notebook, padding=10)
        self.jobs_tab = ttk.Frame(notebook, padding=10)
        self.advanced_tab = ttk.Frame(notebook, padding=10)
        notebook.add(self.sheet_tab, text="Sheet && Folders")
        notebook.add(self.printers_tab, text="Printers && Routing")
        notebook.add(self.jobs_tab, text="Watermarks && Pages")
        notebook.add(self.advanced_tab, text="Advanced")

        self._build_sheet_tab()
        self._build_printers_tab()
        self._build_jobs_tab()
        self._build_advanced_tab()

        self.status_var = tk.StringVar(value="")
        ttk.Label(self, textvariable=self.status_var, foreground="#a00",
                  wraplength=560, justify="left").pack(fill="x", padx=12)

        buttons = ttk.Frame(self)
        buttons.pack(fill="x", padx=12, pady=(0, 10))
        ttk.Button(buttons, text="Restore Defaults", command=self._restore_defaults).pack(side="left")
        ttk.Button(buttons, text="Cancel", command=root.destroy).pack(side="right")
        ttk.Button(buttons, text="Save", command=self._save).pack(side="right", padx=6)
        ttk.Button(buttons, text="Save && Close", command=self._save_and_close).pack(side="right")

    # ---- Sheet & Folders -----------------------------------------------
    def _build_sheet_tab(self):
        cfg = self.config
        t = self.sheet_tab
        t.columnconfigure(1, weight=1)

        self.csv_url_var = tk.StringVar(value=cfg["sheet"]["csv_url"])
        self.col_name_var = tk.StringVar(value=cfg["sheet"]["col_name"])
        self.col_items_var = tk.StringVar(value=cfg["sheet"]["col_items"])
        self.base_var = tk.StringVar(value=cfg["paths"]["base"])
        self.deck_subdir_var = tk.StringVar(value=cfg["paths"]["deck_subdir"])
        self.assess_subdir_var = tk.StringVar(value=cfg["paths"]["assess_subdir"])

        ttk.Label(t, text="Google Sheet, published as CSV", font=("", 10, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 6))
        _labeled_entry(t, 1, "Sheet CSV URL:", self.csv_url_var)
        _labeled_entry(t, 2, "Name column header:", self.col_name_var, width=30)
        _labeled_entry(t, 3, "Print-items column header:", self.col_items_var, width=30)

        ttk.Separator(t).grid(row=4, column=0, columnspan=2, sticky="we", pady=10)

        ttk.Label(t, text="Student file locations", font=("", 10, "bold")).grid(
            row=5, column=0, columnspan=2, sticky="w", pady=(0, 6))
        _labeled_entry(t, 6, "Base folder (UNC path):", self.base_var)
        _labeled_entry(t, 7, "Decks subfolder:", self.deck_subdir_var, width=30)
        _labeled_entry(t, 8, "Assessments subfolder:", self.assess_subdir_var, width=30)

    # ---- Printers & Routing ---------------------------------------------
    def _build_printers_tab(self):
        t = self.printers_tab
        t.columnconfigure(0, weight=1)

        ttk.Label(t, text="Printers (name, protocol, and pacing to manage heat)",
                  font=("", 10, "bold")).grid(row=0, column=0, sticky="w")
        header = ttk.Frame(t)
        header.grid(row=1, column=0, sticky="w", pady=(4, 0))
        for col, text in enumerate(["Name", "", "", "gap(s)", "every", "rest(s)"]):
            ttk.Label(header, text=text, width=6 if col else 18).grid(row=0, column=col)

        self.printers_frame = ttk.Frame(t)
        self.printers_frame.grid(row=2, column=0, sticky="we", pady=4)

        for name, p in self.config["printers"].items():
            self._add_printer_row(name, p["duplex"], p["paced"], p["gap"], p["batch"], p["batch_pause"])

        ttk.Button(t, text="+ Add printer", command=lambda: self._add_printer_row()).grid(
            row=3, column=0, sticky="w", pady=(0, 12))

        ttk.Separator(t).grid(row=4, column=0, sticky="we", pady=6)

        ttk.Label(t, text="Routing -- which printer handles each kind of job",
                  font=("", 10, "bold")).grid(row=5, column=0, sticky="w", pady=(0, 6))
        self.routing_frame = ttk.Frame(t)
        self.routing_frame.grid(row=6, column=0, sticky="w")
        self.routing_vars = {}
        for i, kind in enumerate(JOB_KINDS):
            ttk.Label(self.routing_frame, text=JOB_LABELS[kind] + ":").grid(
                row=i, column=0, sticky="w", padx=(0, 8), pady=2)
            var = tk.StringVar(value=self.config["routing"].get(kind, ""))
            combo = ttk.Combobox(self.routing_frame, textvariable=var, state="readonly", width=22)
            combo.grid(row=i, column=1, pady=2)
            self.routing_vars[kind] = (var, combo)
        self._refresh_routing_options()

    def _add_printer_row(self, name="", duplex=False, paced=False, gap=30, batch=4, batch_pause=60):
        row = PrinterRow(self.printers_frame, self._refresh_routing_options, self._printer_renamed,
                          name=name, duplex=duplex, paced=paced,
                          gap=gap, batch=batch, batch_pause=batch_pause)
        row.pack(fill="x", pady=2)
        self.printer_rows.append(row)

    def _live_printer_names(self):
        names = [r.name_var.get().strip() for r in self.printer_rows if r.winfo_exists()]
        return [n for n in names if n]

    def _printer_renamed(self, old, new):
        """A printer's name changed in place (not removed) -- carry any
        routing that pointed at the old name over to the new one, so a
        rename can't silently strand a job kind on a printer that no
        longer exists."""
        if hasattr(self, "routing_vars"):
            for kind, (var, _combo) in self.routing_vars.items():
                if var.get() == old:
                    var.set(new)
        self._refresh_routing_options()

    def _refresh_routing_options(self):
        self.printer_rows = [r for r in self.printer_rows if r.winfo_exists()]
        names = self._live_printer_names()
        if not hasattr(self, "routing_vars"):
            return
        for kind, (var, combo) in self.routing_vars.items():
            combo["values"] = names
            # An out-of-date selection (e.g. after removing a printer) is
            # left visible rather than silently reassigned -- validate()
            # will flag it clearly on Save.

    # ---- Watermarks & Pages ---------------------------------------------
    def _build_jobs_tab(self):
        cfg = self.config
        t = self.jobs_tab
        t.columnconfigure(1, weight=1)

        self.temp_watermark_var = tk.StringVar(value=cfg["temp"]["watermark"])
        self.temp_pages_var = tk.StringVar(value=str(cfg["temp"]["pages"]))
        self.supp_watermark_var = tk.StringVar(value=cfg["supp"]["watermark"])
        self.supp_pages_var = tk.StringVar(value=str(cfg["supp"]["pages"]))
        self.supp_label_var = tk.StringVar(value=cfg["supp"]["label"])
        self.wm_font_var = tk.StringVar(value=cfg["watermark_style"]["font"])
        self.wm_size_var = tk.StringVar(value=str(cfg["watermark_style"]["size"]))
        self.wm_darkness_var = tk.StringVar(value=str(cfg["watermark_style"]["darkness"]))

        ttk.Label(t, text="TEMP decks", font=("", 10, "bold")).grid(row=0, column=0, columnspan=2, sticky="w")
        _labeled_entry(t, 1, "Watermark text (blank = none):", self.temp_watermark_var, width=20)
        _labeled_entry(t, 2, "Page cap:", self.temp_pages_var, width=6)

        ttk.Separator(t).grid(row=3, column=0, columnspan=2, sticky="we", pady=10)

        ttk.Label(t, text="SUPP (auto-attached to the first LP)", font=("", 10, "bold")).grid(
            row=4, column=0, columnspan=2, sticky="w")
        _labeled_entry(t, 5, "Filename label to match:", self.supp_label_var, width=20)
        _labeled_entry(t, 6, "Watermark text:", self.supp_watermark_var, width=20)
        _labeled_entry(t, 7, "Page cap:", self.supp_pages_var, width=6)

        ttk.Separator(t).grid(row=8, column=0, columnspan=2, sticky="we", pady=10)

        ttk.Label(t, text="Watermark style", font=("", 10, "bold")).grid(row=9, column=0, columnspan=2, sticky="w")
        _labeled_entry(t, 10, "Font:", self.wm_font_var, width=20)
        _labeled_entry(t, 11, "Size (points):", self.wm_size_var, width=6)
        _labeled_entry(t, 12, "Darkness (0-1):", self.wm_darkness_var, width=6)

    # ---- Advanced ---------------------------------------------------------
    def _build_advanced_tab(self):
        cfg = self.config
        t = self.advanced_tab
        t.columnconfigure(1, weight=1)

        self.print_settings_var = tk.StringVar(value=cfg["print"]["settings"])
        self.copies_var = tk.StringVar(value=str(cfg["print"]["copies"]))
        self.timeout_var = tk.StringVar(value=str(cfg["print"]["timeout"]))
        self.retain_var = tk.BooleanVar(value=cfg["behavior"]["retain_watermarked"])
        self.log_path_var = tk.StringVar(value=cfg["behavior"]["log_path"])

        ttk.Label(t, text="Scaling ('noscale' keeps true scale -- these are "
                          "dimensioned drawings):").grid(row=0, column=0, sticky="w", padx=4, pady=3)
        ttk.Combobox(t, textvariable=self.print_settings_var, state="readonly",
                     values=["noscale", "fit", "shrink"], width=12).grid(row=0, column=1, sticky="w")
        _labeled_entry(t, 1, "Copies:", self.copies_var, width=6)
        _labeled_entry(t, 2, "Per-print timeout (seconds):", self.timeout_var, width=6)
        ttk.Checkbutton(t, text="Keep watermarked temp copies for inspection",
                        variable=self.retain_var).grid(row=3, column=0, columnspan=2, sticky="w", pady=4)
        _labeled_entry(t, 4, "Print log file:", self.log_path_var, width=30)

    # ---- collect / save ---------------------------------------------------
    def _int_field(self, raw, label, problems, minimum=0):
        try:
            value = int(str(raw).strip())
        except (TypeError, ValueError):
            problems.append(f"{label} must be a whole number.")
            return minimum
        if value < minimum:
            problems.append(f"{label} must be at least {minimum}.")
        return value

    def _float_field(self, raw, label, problems):
        try:
            return float(str(raw).strip())
        except (TypeError, ValueError):
            problems.append(f"{label} must be a number.")
            return 0.0

    def _collect(self):
        """Build a config dict from the current widgets. Returns (config, problems)
        for anything that couldn't even be parsed (validate() catches the rest)."""
        problems = []

        printers = {}
        for row in self.printer_rows:
            if not row.winfo_exists():
                continue
            d = row.to_dict()
            name = d["name"]
            if not name:
                continue
            batch_minimum = 1 if d["paced"] else 0
            printers[name] = {
                "duplex": d["duplex"],
                "paced": d["paced"],
                "gap": self._int_field(d["gap"], f"{name}: gap", problems),
                "batch": self._int_field(d["batch"], f"{name}: every-N", problems, minimum=batch_minimum),
                "batch_pause": self._int_field(d["batch_pause"], f"{name}: rest", problems),
            }

        routing = {kind: var.get().strip() for kind, (var, _combo) in self.routing_vars.items()}

        config = {
            "sheet": {
                "csv_url": self.csv_url_var.get().strip(),
                "col_name": self.col_name_var.get().strip(),
                "col_items": self.col_items_var.get().strip(),
            },
            "paths": {
                "base": self.base_var.get().strip(),
                "deck_subdir": self.deck_subdir_var.get().strip(),
                "assess_subdir": self.assess_subdir_var.get().strip(),
            },
            "printers": printers,
            "routing": routing,
            "temp": {
                "watermark": self.temp_watermark_var.get(),
                "pages": self._int_field(self.temp_pages_var.get(), "TEMP page cap", problems, minimum=1),
            },
            "supp": {
                "watermark": self.supp_watermark_var.get(),
                "pages": self._int_field(self.supp_pages_var.get(), "SUPP page cap", problems, minimum=1),
                "label": self.supp_label_var.get().strip(),
            },
            "print": {
                "settings": self.print_settings_var.get(),
                "copies": self._int_field(self.copies_var.get(), "Copies", problems, minimum=1),
                "timeout": self._int_field(self.timeout_var.get(), "Print timeout", problems, minimum=1),
            },
            "behavior": {
                "retain_watermarked": bool(self.retain_var.get()),
                "log_path": self.log_path_var.get().strip(),
            },
            "watermark_style": {
                "font": self.wm_font_var.get().strip(),
                "size": self._int_field(self.wm_size_var.get(), "Watermark size", problems, minimum=1),
                "darkness": self._float_field(self.wm_darkness_var.get(), "Watermark darkness", problems),
            },
        }
        return config, problems

    def _save(self):
        self._refresh_routing_options()
        config, problems = self._collect()
        problems += validate(config)
        if problems:
            self.status_var.set("Not saved:\n" + "\n".join(f"- {p}" for p in problems))
            return False
        save_config(config)
        self.config = config
        self.status_var.set("")
        messagebox.showinfo("Batch Print Settings", "Settings saved.")
        return True

    def _save_and_close(self):
        if self._save():
            self.root.destroy()

    def _restore_defaults(self):
        if messagebox.askyesno("Restore Defaults",
                                "Discard the current settings and reload the built-in defaults?\n"
                                "Nothing is written until you click Save."):
            self.root.destroy()
            main(reset=True)


def main(reset=False):
    from config_store import default_config

    root = tk.Tk()
    root.title("Batch Print Settings")
    root.minsize(640, 420)
    initial = default_config() if reset else None
    app = SettingsApp(root, initial_config=initial)
    app.pack(fill="both", expand=True)
    root.mainloop()


if __name__ == "__main__":
    main()
