"""Feature builders shared by training (model/train.py) and runtime (app.py).

Pure Python only (stdlib): AppSail runs with Flask and nothing else.

- quickml_row_features: the exact columns the Catalyst QuickML model is
  trained on (copied verbatim from quickml/make_quickml_csv.py).
- linear_features / gbm_features: inputs of the local hybrid model.
"""
import math
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


# Hour blocks used for temperature interactions in the linear base.
def hour_block(hour):
    if hour >= 23 or hour <= 5:
        return 0  # night
    if hour <= 9:
        return 1  # morning ramp
    if hour <= 17:
        return 2  # daytime
    return 3      # evening peak 18-22


HOT_KNOTS = (10.0, 15.0, 20.0, 24.0, 28.0, 32.0)
COLD_KNOTS = (10.0, 15.0)
BLOCK_KNOTS = (22.0, 28.0)


def linear_feature_names():
    names = ["hour_%02d" % h for h in range(24)]
    names += ["is_weekend", "temp"]
    names += ["hot_%g" % k for k in HOT_KNOTS]
    names += ["cold_%g" % k for k in COLD_KNOTS]
    names += ["humidity", "solar_100"]
    for b in range(4):
        for k in BLOCK_KNOTS:
            names.append("blk%d_hot_%g" % (b, k))
        names.append("blk%d_cold_15" % b)
    return names


def linear_features(d, t, h, s):
    """d: datetime. Returns a list of floats aligned with linear_feature_names()."""
    hour = d.hour
    x = [0.0] * 24
    x[hour] = 1.0
    x.append(1.0 if d.weekday() >= 5 else 0.0)
    x.append(float(t))
    for k in HOT_KNOTS:
        x.append(max(0.0, t - k))
    for k in COLD_KNOTS:
        x.append(max(0.0, k - t))
    x.append(float(h))
    x.append(float(s) / 100.0)
    blk = hour_block(hour)
    for b in range(4):
        on = 1.0 if b == blk else 0.0
        for k in BLOCK_KNOTS:
            x.append(on * max(0.0, t - k))
        x.append(on * max(0.0, 15.0 - t))
    return x


GBM_FEATURES = ["hour", "day_of_week", "is_weekend", "ambient_temp_c", "humidity_pct",
                "solar_irradiance_wm2", "cooling_degree", "heating_degree", "is_evening_peak"]


def gbm_features(d, t, h, s):
    """Row-wise features for the residual GBM. No month/day-of-year on purpose:
    trees cannot extrapolate calendar position into unseen (summer) months."""
    hour = d.hour
    wd = d.weekday()
    return [float(hour), float(wd), 1.0 if wd >= 5 else 0.0, float(t), float(h), float(s),
            max(0.0, t - 22.0), max(0.0, 15.0 - t), 1.0 if 18 <= hour <= 22 else 0.0]
