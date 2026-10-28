"""Builds the QuickML training CSV: row-wise features only (no lags), so the
QuickML endpoint can score any single row. Keep in sync with
appsail/gridpilot/features.py::quickml_row_features."""
import csv, math, sys
from datetime import datetime
def quickml_row_features(ts, t, h, s):
    d = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    return {
        "hour": d.hour, "day_of_week": d.weekday(), "is_weekend": int(d.weekday() >= 5),
        "month": d.month, "day_of_year": d.timetuple().tm_yday,
        "hour_sin": round(math.sin(2*math.pi*d.hour/24), 6), "hour_cos": round(math.cos(2*math.pi*d.hour/24), 6),
        "ambient_temp_c": t, "humidity_pct": h, "solar_irradiance_wm2": s,
        "cooling_degree": round(max(0.0, t-22.0), 4), "heating_degree": round(max(0.0, 15.0-t), 4),
        "is_evening_peak": int(18 <= d.hour <= 22),
    }
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f, open(dst, "w", newline="") as g:
    r = csv.DictReader(f); w = None
    for row in r:
        feats = quickml_row_features(row["timestamp"], float(row["ambient_temp_c"]), float(row["humidity_pct"]), float(row["solar_irradiance_wm2"]))
        feats["target_demand_kw"] = float(row["target_demand_kw"])
        if w is None: w = csv.DictWriter(g, fieldnames=list(feats)); w.writeheader()
        w.writerow(feats)
