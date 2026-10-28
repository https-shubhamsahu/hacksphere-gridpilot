"""Telemetry cleaning and validation (stdlib only).

Two modes:
- clean_forecast_rows: dashboard/forecast path. Drops rows with unparseable
  timestamps, dedupes timestamps (last wins), sorts by time, imputes, clips.
- clean_predict_rows: /api/predict path. Keeps rows 1:1 with the input (no drop,
  no reorder); bad timestamps are imputed from neighbours.
"""
from datetime import datetime, timedelta, timezone

NUM_COLS = ("ambient_temp_c", "humidity_pct", "solar_irradiance_wm2")
CLIP = {
    "ambient_temp_c": (-30.0, 60.0),
    "humidity_pct": (0.0, 100.0),
    "solar_irradiance_wm2": (0.0, None),
}
# Last-resort defaults if a whole column is missing (training-data medians).
DEFAULTS = {"ambient_temp_c": 20.0, "humidity_pct": 65.0, "solar_irradiance_wm2": 0.0}

TS_FORMATS = (
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%d %H:%M:%S.%f",
    "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M",
    "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d",
)
OUT_FMT = "%Y-%m-%d %H:%M:%S"


def parse_timestamp(value):
    """Return a naive datetime or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    s = str(value).strip()
    if not s or s.lower() in ("nan", "none", "null", "nat"):
        return None
    if s.endswith("Z"):
        s = s[:-1]
    # strip timezone offsets like +05:30 / -0000
    if len(s) > 19 and (s[-6] in "+-" and s[-3] == ":"):
        s = s[:-6]
    elif len(s) > 19 and s[-5] in "+-" and s[-4:].isdigit():
        s = s[:-5]
    for fmt in TS_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # epoch seconds
    try:
        f = float(s)
        if 1e8 < f < 1e11:
            return datetime.fromtimestamp(f, timezone.utc).replace(tzinfo=None)
    except ValueError:
        pass
    return None


def to_float(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    else:
        s = str(value).strip().replace(",", "")
        if not s or s.lower() in ("nan", "none", "null", "na", "n/a", "-", "?"):
            return None
        for suffix in ("°c", "c", "%", "w/m2", "wm2"):
            if s.lower().endswith(suffix):
                s = s[: -len(suffix)].strip()
                break
        try:
            f = float(s)
        except ValueError:
            return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _median(vals):
    v = sorted(vals)
    if not v:
        return None
    m = len(v) // 2
    return v[m] if len(v) % 2 else 0.5 * (v[m - 1] + v[m])


def _impute_column(times, values):
    """Linear interpolation in time between known neighbours; nearest value at the
    edges; column median (or default) if nothing is known. Returns (values, count)."""
    known = [i for i, v in enumerate(values) if v is not None]
    n_missing = len(values) - len(known)
    if n_missing == 0:
        return values, 0
    out = list(values)
    if not known:
        return out, n_missing  # caller fills with default
    for i in range(len(out)):
        if out[i] is not None:
            continue
        # neighbours
        prev = next_ = None
        for j in range(i - 1, -1, -1):
            if values[j] is not None:
                prev = j
                break
        for j in range(i + 1, len(values)):
            if values[j] is not None:
                next_ = j
                break
        if prev is not None and next_ is not None:
            t0, t1, ti = times[prev], times[next_], times[i]
            if t0 is not None and t1 is not None and ti is not None and t1 != t0:
                w = (ti - t0).total_seconds() / (t1 - t0).total_seconds()
                w = min(1.0, max(0.0, w))
            else:
                w = float(i - prev) / float(next_ - prev)
            out[i] = values[prev] + w * (values[next_] - values[prev])
        elif prev is not None:
            out[i] = values[prev]
        elif next_ is not None:
            out[i] = values[next_]
    return out, n_missing


def _clip(col, v):
    lo, hi = CLIP[col]
    c = v
    if lo is not None and c < lo:
        c = lo
    if hi is not None and c > hi:
        c = hi
    return c


def _finish(rows_in, times, cols, warnings, dropped):
    imputed, clipped = {}, {}
    for col in NUM_COLS:
        # clip known values first so imputation never interpolates from out-of-range readings
        vals = list(cols[col])
        n_clip = 0
        for i, v in enumerate(vals):
            if v is None:
                continue
            c = _clip(col, v)
            if c != v:
                n_clip += 1
                vals[i] = c
        vals, n_imp = _impute_column(times, vals)
        med = _median([v for v in vals if v is not None])
        fill = med if med is not None else DEFAULTS[col]
        vals = [fill if v is None else v for v in vals]
        cols[col] = vals
        if n_imp:
            imputed[col] = n_imp
            warnings.append("%d missing/invalid %s value(s) imputed" % (n_imp, col))
        if n_clip:
            clipped[col] = n_clip
            warnings.append("%d out-of-range %s value(s) clipped" % (n_clip, col))
    rows = []
    for i, t in enumerate(times):
        rows.append({
            "timestamp": t.strftime(OUT_FMT),
            "ambient_temp_c": round(cols["ambient_temp_c"][i], 4),
            "humidity_pct": round(cols["humidity_pct"][i], 4),
            "solar_irradiance_wm2": round(cols["solar_irradiance_wm2"][i], 4),
        })
    report = {"rows_in": rows_in, "rows_out": len(rows), "dropped": dropped,
              "imputed": imputed, "clipped": clipped, "warnings": warnings}
    return rows, report


def _get(row, key):
    if not isinstance(row, dict):
        return None
    if key in row:
        return row[key]
    lk = key.lower()
    for k, v in row.items():
        if str(k).strip().lower() == lk:
            return v
    return None


def clean_forecast_rows(raw_rows):
    """Drop bad timestamps, dedupe, sort, impute, clip."""
    warnings = []
    rows_in = len(raw_rows)
    parsed = []
    bad_ts = 0
    for r in raw_rows:
        d = parse_timestamp(_get(r, "timestamp"))
        if d is None:
            bad_ts += 1
            continue
        parsed.append((d, {c: to_float(_get(r, c)) for c in NUM_COLS}))
    if bad_ts:
        warnings.append("%d row(s) dropped: unparseable timestamp" % bad_ts)
    by_ts = {}
    for d, vals in parsed:
        by_ts[d] = vals
    dupes = len(parsed) - len(by_ts)
    if dupes:
        warnings.append("%d duplicate timestamp row(s) removed (last kept)" % dupes)
    times = sorted(by_ts)
    cols = {c: [by_ts[t][c] for t in times] for c in NUM_COLS}
    return _finish(rows_in, times, cols, warnings, bad_ts + dupes)


def clean_predict_rows(raw_rows):
    """Keep 1:1 with input. Unparseable timestamps are filled from the previous
    valid row + 1 h (or next valid row - 1 h)."""
    warnings = []
    times = [parse_timestamp(_get(r, "timestamp")) for r in raw_rows]
    n_bad = sum(1 for t in times if t is None)
    if n_bad:
        warnings.append("%d unparseable timestamp(s) inferred from neighbouring rows" % n_bad)
        fixed = list(times)
        for i in range(len(fixed)):
            if fixed[i] is None and i > 0 and fixed[i - 1] is not None:
                fixed[i] = fixed[i - 1] + timedelta(hours=1)
        for i in range(len(fixed) - 1, -1, -1):
            if fixed[i] is None and i + 1 < len(fixed) and fixed[i + 1] is not None:
                fixed[i] = fixed[i + 1] - timedelta(hours=1)
        anchor = datetime(2015, 6, 16, 0, 0, 0)
        times = [t if t is not None else anchor + timedelta(hours=i) for i, t in enumerate(fixed)]
    cols = {c: [to_float(_get(r, c)) for r in raw_rows] for c in NUM_COLS}
    return _finish(len(raw_rows), times, cols, warnings, 0)


def parse_csv_text(text):
    """CSV text -> list of dict rows (header row required)."""
    import csv
    import io
    if text.startswith("﻿"):
        text = text[1:]
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for r in reader:
        if r is None:
            continue
        clean = {}
        for k, v in r.items():
            if k is None:
                continue
            clean[str(k).strip().lower()] = v
        if any(v not in (None, "") for v in clean.values()):
            rows.append(clean)
    return rows
