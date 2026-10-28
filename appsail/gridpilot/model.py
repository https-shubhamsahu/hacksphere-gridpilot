"""Pure-Python inference for the exported GridPilot model (appsail/model.json).

model.json holds:
  linear: {"features": [...], "intercept": float, "coef": [...]}   (ridge base)
  gbm:    {"features": [...], "trees": [{"sf","th","dl","lc","rc","lv"}]}  (LightGBM residual trees)
Prediction = linear(x) + sum(tree leaves) , clipped to "clip" range.
No numpy / pandas / sklearn / lightgbm needed at runtime.
"""
import json
import math
import os
from datetime import datetime

from .features import gbm_features, linear_features

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_PATH = os.path.join(os.path.dirname(_HERE), "model.json")


def _walk(tree, x):
    sf, th, dl, lc, rc, lv = tree["sf"], tree["th"], tree["dl"], tree["lc"], tree["rc"], tree["lv"]
    if not sf:  # single-leaf tree
        return lv[0]
    node = 0
    while True:
        v = x[sf[node]]
        if v != v:  # NaN
            go_left = dl[node]
        else:
            go_left = v <= th[node]
        nxt = lc[node] if go_left else rc[node]
        if nxt < 0:
            return lv[~nxt]
        node = nxt


class LocalModel(object):
    def __init__(self, spec):
        self.spec = spec
        self.name = spec.get("name", "gridpilot-local")
        self.version = spec.get("version", "0")
        self.validation_rmse = float(spec.get("validation", {}).get("rmse", 0.0))
        self.linear = spec.get("linear")
        self.gbm = spec.get("gbm")
        clip = spec.get("clip") or [0.0, 1000.0]
        self.lo, self.hi = float(clip[0]), float(clip[1])
        self.fallback = float(spec.get("fallback_kw", 150.0))

    @classmethod
    def load(cls, path=None):
        with open(path or DEFAULT_MODEL_PATH) as f:
            return cls(json.load(f))

    def predict_one(self, d, t, h, s):
        """d: datetime, t/h/s: floats (already cleaned)."""
        y = 0.0
        if self.linear:
            xl = linear_features(d, t, h, s)
            y += self.linear["intercept"]
            for c, v in zip(self.linear["coef"], xl):
                y += c * v
        if self.gbm:
            xg = gbm_features(d, t, h, s)
            for tree in self.gbm["trees"]:
                y += _walk(tree, xg)
        return y

    def predict_rows(self, rows, clip=True):
        """rows: list of dicts with keys timestamp (str or datetime), ambient_temp_c,
        humidity_pct, solar_irradiance_wm2. Returns list of floats, never NaN."""
        out = []
        for r in rows:
            d = r["timestamp"]
            if not isinstance(d, datetime):
                d = datetime.strptime(str(d), "%Y-%m-%d %H:%M:%S")
            y = self.predict_one(d, float(r["ambient_temp_c"]), float(r["humidity_pct"]),
                                 float(r["solar_irradiance_wm2"]))
            if y != y or math.isinf(y):
                y = self.fallback
            if clip:
                y = min(self.hi, max(self.lo, y))
            out.append(y)
        return out


_MODEL = None


def get_model():
    global _MODEL
    if _MODEL is None:
        _MODEL = LocalModel.load()
    return _MODEL
