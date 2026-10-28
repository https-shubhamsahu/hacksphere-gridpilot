import argparse

import json

import math

import os

import sys

import time

import numpy as np

import pandas as pd

try:
    import requests
except ImportError:  # requests is optional; urllib is used if it is missing
    requests = None


# Published GridPilot prediction endpoint (Zoho Catalyst AppSail -> QuickML).
QUICKML_ENDPOINT_URL = os.environ.get("QUICKML_ENDPOINT_URL", "https://gridpilot-50047251149.development.catalystappsail.in/api/predict")

CHUNK_ROWS = 500
TIMEOUT_S = 30
RETRIES = 1

HERE = os.path.dirname(os.path.abspath(__file__))
FEATURE_COLS = ["timestamp", "ambient_temp_c", "humidity_pct", "solar_irradiance_wm2"]

# Compact embedded fallback (ridge on hour-of-day + temperature hinges + humidity,
# fit on all of train_telemetry.csv; chronological validation RMSE 10.39 kW).
# Used only if both the endpoint and appsail/model.json are unavailable.
_HOUR_BASE = [-1.46, -0.79, -0.57, -1.04, -1.76, -1.15, 41.65, 81.44, 82.62, 82.28, 53.24, 51.91,
              51.35, 52.31, 52.69, 51.86, 52.35, 52.35, 105.13, 107.1, 107.46, 106.16, 105.54, 18.91]
_TERMS = [8.1751, 2.4244, -1.7902, 1.2514]  # hot>22C, hot>28C, cold<15C, humidity


def _clean_frame(input_df):
    """Numeric coercion + time-aware imputation; keeps rows 1:1 and in order."""
    df = input_df.copy()
    try:
        ts = pd.to_datetime(df["timestamp"], errors="coerce", format="mixed")
    except (TypeError, ValueError):
        ts = pd.to_datetime(df["timestamp"], errors="coerce")
    if getattr(ts.dt, "tz", None) is not None:
        ts = ts.dt.tz_localize(None)
    if ts.isna().any():  # unparseable timestamps: borrow the neighbouring hour
        ts = ts.ffill().bfill().fillna(pd.Timestamp("2015-06-16"))
    df["timestamp"] = ts.dt.strftime("%Y-%m-%d %H:%M:%S")
    defaults = {"ambient_temp_c": 20.0, "humidity_pct": 65.0, "solar_irradiance_wm2": 0.0}
    for c in FEATURE_COLS[1:]:
        if c not in df.columns:
            df[c] = np.nan
        df[c] = pd.to_numeric(df[c], errors="coerce").replace([np.inf, -np.inf], np.nan)
        df[c] = df[c].interpolate(limit_direction="both")
        df[c] = df[c].fillna(df[c].median() if df[c].notna().any() else defaults[c])
    df["ambient_temp_c"] = df["ambient_temp_c"].clip(-30, 60)
    df["humidity_pct"] = df["humidity_pct"].clip(0, 100)
    df["solar_irradiance_wm2"] = df["solar_irradiance_wm2"].clip(lower=0)
    return df[FEATURE_COLS]


def _embedded_linear(df):
    hours = pd.to_datetime(df["timestamp"]).dt.hour.values
    t = df["ambient_temp_c"].values.astype(float)
    h = df["humidity_pct"].values.astype(float)
    base = np.array(_HOUR_BASE)[hours]
    return (base + _TERMS[0] * np.maximum(0, t - 22) + _TERMS[1] * np.maximum(0, t - 28)
            + _TERMS[2] * np.maximum(0, 15 - t) + _TERMS[3] * h)


def _local_predict(input_df):
    """Local fallback: the exported hybrid model (appsail/model.json) evaluated with the
    same pure-Python code the server runs; else the embedded linear model."""
    df = _clean_frame(input_df)
    try:
        sys.path.insert(0, os.path.join(HERE, "appsail"))
        from gridpilot.model import LocalModel  # noqa: E402
        model = LocalModel.load(os.path.join(HERE, "appsail", "model.json"))
        preds = np.array(model.predict_rows(df.to_dict(orient="records")), dtype=float)
    except Exception as e:  # noqa: BLE001
        print(f"Warning: appsail/model.json unavailable ({e}); using embedded linear model.")
        preds = _embedded_linear(df)
    bad = ~np.isfinite(preds)
    if bad.any():
        preds[bad] = _embedded_linear(df)[bad]
    return preds


def _post(url, payload):
    if requests is not None:
        r = requests.post(url, json=payload, timeout=TIMEOUT_S)
        r.raise_for_status()
        return r.json()
    import urllib.request
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode())


def _records(chunk):
    recs = []
    for r in chunk.to_dict(orient="records"):
        clean = {}
        for k, v in r.items():
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                v = None
            elif isinstance(v, pd.Timestamp):
                v = v.strftime("%Y-%m-%d %H:%M:%S")
            elif hasattr(v, "item"):
                v = v.item()
            clean[k] = v
        recs.append(clean)
    return recs


def predict(input_df: pd.DataFrame):

    """Parameters:


        input_df (pandas.DataFrame): DataFrame with columns

        ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2']


    Returns:

        numpy.ndarray or list: Predicted demand (kW) for each input row.

    """

    n = len(input_df)
    if n == 0:
        return np.array([], dtype=float)
    cols = [c for c in FEATURE_COLS if c in input_df.columns]
    df = input_df[cols].reset_index(drop=True)
    out = np.full(n, np.nan)

    if "REPLACE_WITH" not in QUICKML_ENDPOINT_URL:
        for start in range(0, n, CHUNK_ROWS):
            chunk = df.iloc[start:start + CHUNK_ROWS]
            payload = {"data": _records(chunk)}
            for attempt in range(RETRIES + 1):
                try:
                    result = _post(QUICKML_ENDPOINT_URL, payload)
                    vals = np.array(result["predictions"], dtype=float)
                    if len(vals) != len(chunk) or not np.isfinite(vals).all():
                        raise ValueError(f"bad response: {len(vals)} values for {len(chunk)} rows")
                    out[start:start + len(chunk)] = vals
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"Warning: QuickML endpoint call failed ({e}) [chunk {start}, attempt {attempt + 1}].")
                    if attempt < RETRIES:
                        time.sleep(1.0)

    missing = ~np.isfinite(out)
    if missing.any():
        local = _local_predict(df)
        out[missing] = local[missing]
    return np.array(out, dtype=float)


if __name__ == "__main__":

    parser = argparse.ArgumentParser(description="GridPilot demand predictions")
    parser.add_argument("--input", default=None, help="input CSV (timestamp + 3 weather columns)")
    parser.add_argument("--output", default=None, help="output CSV: timestamp,target_demand_kw")
    args = parser.parse_args()

    if args.input is None and args.output is None:
        print("Testing predict.py on sample_test_input.csv...")
        sample_df = pd.read_csv("sample_test_input.csv")
        preds = predict(sample_df)
        print(
            f"Generated {len(preds)} predictions. First 5 samples:\n{preds[:5]}"
        )
    else:
        in_path = args.input or "sample_test_input.csv"
        sample_df = pd.read_csv(in_path)
        preds = predict(sample_df)
        out_df = pd.DataFrame({"timestamp": sample_df["timestamp"],
                               "target_demand_kw": np.round(preds, 2)})
        out_path = args.output or "predictions.csv"
        out_df.to_csv(out_path, index=False, float_format="%.2f")
        print(f"Wrote {len(out_df)} predictions to {out_path}")
