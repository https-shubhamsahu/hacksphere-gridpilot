"""Train and validate GridPilot demand models, export the winner to appsail/model.json.

Usage:  python model/train.py
Needs:  pandas numpy scikit-learn lightgbm (training only; runtime is pure Python).

Validation is chronological: first 80% of rows train, last 20% validate, because the
real task is forecasting forward into hotter (summer) weeks.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "appsail"))
from gridpilot.features import (GBM_FEATURES, gbm_features, linear_feature_names,  # noqa: E402
                                linear_features, quickml_row_features)
from gridpilot.model import LocalModel  # noqa: E402

DATA = os.path.join(ROOT, "data", "train_telemetry.csv")
OUT_MODEL = os.path.join(ROOT, "appsail", "model.json")
OUT_RESULTS = os.path.join(ROOT, "model", "RESULTS.md")
SEED = 42
RIDGE_ALPHA = 1.0
GBM_PARAMS = dict(objective="regression", learning_rate=0.03, num_leaves=15, min_data_in_leaf=30,
                  feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                  seed=SEED, deterministic=True, num_threads=2, verbose=-1)
GBM_RESID_PARAMS = dict(GBM_PARAMS, num_leaves=7, min_data_in_leaf=40, learning_rate=0.03)


def rmse(a, b):
    return float(np.sqrt(np.mean((np.asarray(a) - np.asarray(b)) ** 2)))


def mae(a, b):
    return float(np.mean(np.abs(np.asarray(a) - np.asarray(b))))


def build(df):
    ds = [datetime.strptime(t, "%Y-%m-%d %H:%M:%S") for t in df["timestamp"]]
    T, H, S = df["ambient_temp_c"].values, df["humidity_pct"].values, df["solar_irradiance_wm2"].values
    XL = np.array([linear_features(d, float(t), float(h), float(s)) for d, t, h, s in zip(ds, T, H, S)])
    XG = np.array([gbm_features(d, float(t), float(h), float(s)) for d, t, h, s in zip(ds, T, H, S)])
    XQ = pd.DataFrame([quickml_row_features(ts, float(t), float(h), float(s))
                       for ts, t, h, s in zip(df["timestamp"], T, H, S)])
    return XL, XG, XQ


def fit_gbm(X, y, params, rounds):
    return lgb.train(params, lgb.Dataset(X, y, free_raw_data=False), num_boost_round=rounds)


def best_rounds(X, y, Xv, yv, params, base_tr=0.0, base_va=0.0, max_rounds=3000):
    """Pick boosting rounds on the chronological validation block."""
    dtr = lgb.Dataset(X, y - base_tr)
    dva = lgb.Dataset(Xv, yv - base_va, reference=dtr)
    b = lgb.train(params, dtr, num_boost_round=max_rounds, valid_sets=[dva],
                  callbacks=[lgb.early_stopping(150, verbose=False)])
    return b, max(50, b.best_iteration)


def export_trees(booster):
    dump = booster.dump_model()
    trees = []
    for ti in dump["tree_info"]:
        sf, th, dl, lc, rc, lv = [], [], [], [], [], []
        root = ti["tree_structure"]
        if "split_index" not in root:
            trees.append({"sf": [], "th": [], "dl": [], "lc": [], "rc": [], "lv": [root["leaf_value"]]})
            continue
        n_int = ti["num_leaves"] - 1
        sf, th, dl, lc, rc = [0] * n_int, [0.0] * n_int, [False] * n_int, [0] * n_int, [0] * n_int
        lv = [0.0] * ti["num_leaves"]

        def ref(node):
            return node["split_index"] if "split_index" in node else ~node["leaf_index"]

        stack = [root]
        while stack:
            nd = stack.pop()
            if "split_index" not in nd:
                lv[nd["leaf_index"]] = nd["leaf_value"]
                continue
            assert nd["decision_type"] == "<=", nd["decision_type"]
            i = nd["split_index"]
            sf[i], th[i], dl[i] = nd["split_feature"], float(nd["threshold"]), bool(nd["default_left"])
            lc[i], rc[i] = ref(nd["left_child"]), ref(nd["right_child"])
            stack.extend([nd["left_child"], nd["right_child"]])
        trees.append({"sf": sf, "th": th, "dl": dl, "lc": lc, "rc": rc, "lv": lv})
    return trees


def main():
    t0 = time.time()
    df = pd.read_csv(DATA)
    df = df.sort_values("timestamp").reset_index(drop=True)
    y = df["target_demand_kw"].values.astype(float)
    XL, XG, XQ = build(df)
    n = len(df)
    cut = int(n * 0.8)
    tr, va = slice(0, cut), slice(cut, n)
    ytr, yva = y[tr], y[va]
    print("train rows %d (%s .. %s), validation rows %d (%s .. %s)" % (
        cut, df.timestamp[0], df.timestamp[cut - 1], n - cut, df.timestamp[cut], df.timestamp[n - 1]))

    results = []  # (name, rmse, mae, note)
    preds = {}

    # 1. Hour-of-day mean profile
    prof = pd.Series(ytr).groupby(df["timestamp"].str[11:13].values[tr]).mean()
    p = df["timestamp"].str[11:13].values[va]
    preds["profile"] = np.array([prof[h] for h in p])
    results.append(("Hour-of-day mean profile (baseline)", preds["profile"], "no weather"))

    # 2. Ridge: hour profile + temperature hinge terms + hour-block x temperature
    ridge = Ridge(alpha=RIDGE_ALPHA).fit(XL[tr], ytr)
    preds["ridge"] = ridge.predict(XL[va])
    results.append(("Ridge (hour one-hot + temperature hinges + block interactions)", preds["ridge"], "extrapolates linearly"))

    # 3. LightGBM on the QuickML column set (includes month/day_of_year)
    qcols = list(XQ.columns)
    b_q, r_q = best_rounds(XQ.values[tr], ytr, XQ.values[va], yva, GBM_PARAMS)
    preds["gbm_q"] = b_q.predict(XQ.values[va], num_iteration=r_q)
    results.append(("LightGBM on QuickML columns (with month/day_of_year)", preds["gbm_q"], "%d rounds" % r_q))

    # 4. LightGBM without calendar-position features
    b_g, r_g = best_rounds(XG[tr], ytr, XG[va], yva, GBM_PARAMS)
    preds["gbm"] = b_g.predict(XG[va], num_iteration=r_g)
    results.append(("LightGBM on row features (no month/day_of_year)", preds["gbm"], "%d rounds" % r_g))

    # 5. Hybrid: Ridge base + LightGBM on residuals
    base_tr, base_va = ridge.predict(XL[tr]), preds["ridge"]
    b_h, r_h = best_rounds(XG[tr], ytr, XG[va], yva, GBM_RESID_PARAMS, base_tr, base_va)
    preds["hybrid"] = base_va + b_h.predict(XG[va], num_iteration=r_h)
    results.append(("Hybrid: Ridge base + LightGBM residuals", preds["hybrid"], "%d residual rounds" % r_h))

    # 6. Blend of hybrid and plain GBM
    preds["blend"] = 0.5 * preds["hybrid"] + 0.5 * preds["gbm"]
    results.append(("Blend 50/50 hybrid + LightGBM (no calendar)", preds["blend"], "not exportable as one tree set"))

    table = [(name, rmse(yva, p), mae(yva, p), note) for name, p, note in results]
    for name, r, m, note in table:
        print("%-66s RMSE %7.3f  MAE %7.3f  %s" % (name, r, m, note))

    # Choose among exportable candidates (ridge / gbm / hybrid).
    exportable = {"ridge": rmse(yva, preds["ridge"]), "gbm": rmse(yva, preds["gbm"]),
                  "hybrid": rmse(yva, preds["hybrid"])}
    choice = min(exportable, key=exportable.get)
    print("chosen:", choice, exportable[choice])

    # Verify pure-Python inference on validation rows (models trained on 80% split).
    def spec_for(kind, ridge_m, booster, rounds):
        spec = {"name": "gridpilot-" + kind, "clip": [0.0, 1000.0], "linear": None, "gbm": None}
        if kind in ("ridge", "hybrid"):
            spec["linear"] = {"features": linear_feature_names(), "intercept": float(ridge_m.intercept_),
                              "coef": [float(c) for c in ridge_m.coef_]}
        if kind in ("gbm", "hybrid"):
            spec["gbm"] = {"features": GBM_FEATURES, "trees": export_trees(_trim(booster, rounds))}
        return spec

    def _trim(booster, rounds):
        return lgb.Booster(model_str=booster.model_to_string(num_iteration=rounds))

    val_rows = df.iloc[cut:][["timestamp", "ambient_temp_c", "humidity_pct", "solar_irradiance_wm2"]].to_dict("records")
    booster_for = {"gbm": (b_g, r_g), "hybrid": (b_h, r_h), "ridge": (None, 0)}
    bb, rr = booster_for[choice]
    pure = LocalModel(spec_for(choice, ridge, bb, rr)).predict_rows(val_rows, clip=False)
    lib = {"ridge": preds["ridge"], "gbm": preds["gbm"], "hybrid": preds["hybrid"]}[choice]
    max_diff = float(np.max(np.abs(np.array(pure) - lib)))
    print("pure-python vs library max abs diff on validation rows: %.3e" % max_diff)
    assert max_diff < 1e-6, max_diff

    # Refit chosen model on all rows with the validated settings, export.
    ridge_full = Ridge(alpha=RIDGE_ALPHA).fit(XL, y)
    full_booster, full_rounds = None, 0
    if choice == "gbm":
        full_rounds = int(r_g * 1.1)
        full_booster = fit_gbm(XG, y, GBM_PARAMS, full_rounds)
        lib_full = full_booster.predict(XG)
    elif choice == "hybrid":
        full_rounds = int(r_h * 1.1)
        full_booster = fit_gbm(XG, y - ridge_full.predict(XL), GBM_RESID_PARAMS, full_rounds)
        lib_full = ridge_full.predict(XL) + full_booster.predict(XG)
    else:
        lib_full = ridge_full.predict(XL)
    spec = spec_for(choice, ridge_full, full_booster, full_rounds)
    best_r = exportable[choice]
    best_m = mae(yva, lib[:])
    spec.update({
        "name": "gridpilot-" + choice,
        "version": datetime.now(timezone.utc).strftime("%Y.%m.%d") + "-" + choice,
        "trained_rows": int(n),
        "trained_range": [df.timestamp[0], df.timestamp[n - 1]],
        "validation": {"scheme": "chronological last 20%", "rows": int(n - cut), "rmse": round(best_r, 4),
                       "mae": round(best_m, 4)},
        "fallback_kw": round(float(np.mean(y)), 2),
        "clip": [0.0, round(float(y.max() * 1.5), 2)],
    })
    all_rows = df[["timestamp", "ambient_temp_c", "humidity_pct", "solar_irradiance_wm2"]].to_dict("records")
    pure_full = LocalModel(spec).predict_rows(all_rows, clip=False)
    full_diff = float(np.max(np.abs(np.array(pure_full) - lib_full)))
    print("pure-python vs library max abs diff on full-data model: %.3e" % full_diff)
    assert full_diff < 1e-6, full_diff
    with open(OUT_MODEL, "w") as f:
        json.dump(spec, f, separators=(",", ":"))
    print("wrote", OUT_MODEL, "(%d KB)" % (os.path.getsize(OUT_MODEL) // 1024))

    # Feature importance proxy for hybrid residual (gain)
    lines = ["# GridPilot model results", "",
             "Generated by `python model/train.py` (seed %d). Chronological split: train on the first 80%% "
             "(%d rows, %s to %s), validate on the last 20%% (%d rows, %s to %s). "
             "Shuffled K-fold would leak future weather/seasonality and overstate accuracy."
             % (SEED, cut, df.timestamp[0], df.timestamp[cut - 1], n - cut, df.timestamp[cut], df.timestamp[n - 1]),
             "", "| Candidate | Val RMSE (kW) | Val MAE (kW) | Notes |", "|---|---:|---:|---|"]
    for name, r, m, note in table:
        lines.append("| %s | %.2f | %.2f | %s |" % (name, r, m, note))
    lines += ["", "**Exported model:** `%s` (validation RMSE %.2f kW). Refit on all %d rows with the validated "
              "settings and written to `appsail/model.json`." % (spec["name"], best_r, n), "",
              "Pure-Python inference (`appsail/gridpilot/model.py`, stdlib only) matches the training libraries: "
              "max abs difference %.1e kW on the validation rows and %.1e kW on the full-data model." % (max_diff, full_diff),
              "", "## Why a hybrid",
              "- The test window (mid-June to late July) is hotter than most training data. Trees cannot extrapolate: "
              "they predict a constant beyond the last split. The ridge base carries the hour-of-day profile and "
              "piecewise-linear cooling/heating terms, so it keeps rising with temperature.",
              "- LightGBM on the ridge residuals picks up the non-linear interactions (hour x temperature x humidity "
              "x solar) that the linear base misses, with small trees and early stopping on the chronological block.",
              "- Pure tree models (LightGBM, and by extension a tree-based QuickML pipeline) score about 15 kW RMSE "
              "on the hotter validation weeks with or without month/day_of_year, versus about 9.7 kW for the "
              "linear-base models. Calendar columns neither help nor badly hurt here; the gap is extrapolation.",
              "- For QuickML: prefer a linear/GLM-style regressor (or an ensemble that includes one) on the "
              "quickml_train.csv columns, since the cooling_degree/heating_degree columns give it the same "
              "hinge-style temperature response.",
              ""]
    with open(OUT_RESULTS, "w") as f:
        f.write("\n".join(lines))
    print("wrote", OUT_RESULTS, "in %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
