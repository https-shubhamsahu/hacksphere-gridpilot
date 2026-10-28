"""GridPilot API + dashboard host for Zoho Catalyst AppSail.

Runtime: Python 3.9+, Flask only (inference is pure Python over model.json).
"""
import collections
import os as _os
import sys as _sys

# Catalyst AppSail does not pip-install for us: dependencies are vendored into
# _vendor/ at deploy time (see README, "Deploy to Catalyst").
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "_vendor"))
import csv
import math
import os
import threading
from datetime import datetime, timezone

from flask import Flask, jsonify, make_response, request, send_from_directory

from gridpilot import quickml
from gridpilot.cleaning import clean_forecast_rows, clean_predict_rows, parse_csv_text
from gridpilot.controller import run_controller
from gridpilot.model import get_model

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
SAMPLE_CSV = os.path.join(HERE, "sample_24h.csv")

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024
app.config["JSON_SORT_KEYS"] = False
try:
    app.json.sort_keys = False  # Flask >= 2.2
except AttributeError:
    pass

_events = collections.deque(maxlen=100)
_events_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def log_event(level, message):
    with _events_lock:
        _events.append({"time": now_iso(), "level": level, "message": message})


MODEL = get_model()
log_event("INFO", "GridPilot started: local model %s (validation RMSE %.2f kW), QuickML %s" % (
    MODEL.name, MODEL.validation_rmse, "configured" if quickml.is_configured() else "not configured"))


# ---------------------------------------------------------------- helpers
def predict_clean_rows(rows, purpose="forecast"):
    """Returns (predictions, source). QuickML first if configured, local fallback.
    /api/predict can be pinned to the local model with PREDICT_SOURCE=local."""
    if not rows:
        return [], "local"
    local = None
    use_quickml = quickml.is_configured()
    if purpose == "predict" and os.environ.get("PREDICT_SOURCE", "quickml") == "local":
        use_quickml = False
    if use_quickml:
        try:
            preds = quickml.predict_quickml(rows)
            return [float(p) for p in preds], "quickml"
        except Exception as e:  # noqa: BLE001
            log_event("WARN", "QuickML unavailable, using local model: %s" % str(e)[:200])
    local = MODEL.predict_rows(rows)
    return local, "local"


def _safe(preds, rows):
    out = []
    fallback = None
    for i, p in enumerate(preds):
        if p is None or p != p or math.isinf(p):
            if fallback is None:
                fallback = MODEL.predict_rows(rows)
            p = fallback[i]
        out.append(float(p))
    return out


def _extract_rows(body):
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for k in ("data", "rows", "records", "instances"):
            if isinstance(body.get(k), list):
                return body[k]
    return None


def _bad(msg, code=400, **extra):
    payload = {"error": msg}
    payload.update(extra)
    return jsonify(payload), code


def _forecast(raw_rows, battery):
    rows, report = clean_forecast_rows(raw_rows)
    for w in report["warnings"]:
        log_event("WARN", "cleaning: " + w)
    if not rows:
        return _bad("no valid rows after cleaning", cleaning=report)
    preds, source = predict_clean_rows(rows)
    preds = _safe(preds, rows)
    out_rows, summary, signals = run_controller(rows, preds, battery)
    log_event("INFO", "forecast: %d rows via %s model, peak %.1f kW at %s, %d transition(s)" % (
        len(rows), source, summary["peak_demand_kw"], summary["peak_hour"], summary["transitions"]))
    for s in signals:
        if s["event"] == "OVERLOAD_ALERT":
            log_event("ALERT", "%s overload: %s" % (s["timestamp"], s["detail"]))
        else:
            log_event("INFO", "%s %s" % (s["timestamp"], s["event"]))
    return jsonify({"rows": out_rows, "summary": summary, "signals": signals,
                    "cleaning": report, "model_source": source})


# ---------------------------------------------------------------- CORS
@app.before_request
def _preflight():
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return make_response("", 204)
    return None


@app.after_request
def _cors(resp):
    if request.path.startswith("/api/"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


# ---------------------------------------------------------------- API
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL.name, "model_version": MODEL.version,
                    "validation_rmse": MODEL.validation_rmse,
                    "quickml_configured": quickml.is_configured(), "time": now_iso()})


@app.route("/api/predict", methods=["POST"])
def predict():
    body = request.get_json(silent=True, force=True)
    raw = _extract_rows(body)
    if raw is None:
        return _bad('expected JSON body {"data": [rows...]}')
    rows, report = clean_predict_rows(raw)
    for w in report["warnings"]:
        log_event("WARN", "predict cleaning: " + w)
    preds, source = predict_clean_rows(rows, purpose="predict")
    preds = _safe(preds, rows)
    log_event("INFO", "predict: %d row(s) via %s model" % (len(preds), source))
    return jsonify({"predictions": [round(p, 4) for p in preds], "source": source})


@app.route("/api/forecast", methods=["POST"])
def forecast():
    body = request.get_json(silent=True, force=True)
    raw = _extract_rows(body)
    if raw is None:
        return _bad('expected JSON body {"data": [rows...], "battery": {...}}')
    battery = body.get("battery") if isinstance(body, dict) else None
    return _forecast(raw, battery if isinstance(battery, dict) else None)


@app.route("/api/forecast/csv", methods=["POST"])
def forecast_csv():
    f = request.files.get("file")
    if f is None:
        return _bad('expected multipart form field "file" with a CSV')
    text = f.read().decode("utf-8", errors="replace")
    raw = parse_csv_text(text)
    if not raw:
        return _bad("CSV has no data rows")
    battery = {}
    for k in ("capacity_kwh", "initial_soc_pct"):
        if request.form.get(k):
            battery[k] = request.form.get(k)
    log_event("INFO", "CSV upload: %s (%d rows)" % (f.filename or "file", len(raw)))
    return _forecast(raw, battery or None)


@app.route("/api/sample", methods=["GET"])
def sample():
    with open(SAMPLE_CSV) as fh:
        rows = []
        for r in csv.DictReader(fh):
            rows.append({"timestamp": r["timestamp"],
                         "ambient_temp_c": float(r["ambient_temp_c"]),
                         "humidity_pct": float(r["humidity_pct"]),
                         "solar_irradiance_wm2": float(r["solar_irradiance_wm2"])})
    return jsonify({"data": rows[:24]})


@app.route("/api/logs", methods=["GET"])
def logs():
    with _events_lock:
        return jsonify({"events": list(_events)})


# ---------------------------------------------------------------- static dashboard
@app.route("/")
def index():
    if os.path.exists(os.path.join(STATIC_DIR, "index.html")):
        return send_from_directory(STATIC_DIR, "index.html")
    return "<!doctype html><title>GridPilot</title><p>GridPilot API is running. See /api/health.</p>"


@app.route("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        return _bad("not found", 404)
    full = os.path.join(STATIC_DIR, path)
    if os.path.isfile(full):
        return send_from_directory(STATIC_DIR, path)
    return _bad("not found", 404)


@app.errorhandler(413)
def too_large(_e):
    return _bad("upload too large (max 10 MB)", 413)


@app.errorhandler(500)
def server_error(e):
    log_event("WARN", "server error: %s" % str(e)[:200])
    return _bad("internal error", 500)


if __name__ == "__main__":
    port = int(os.environ.get("X_ZOHO_CATALYST_LISTEN_PORT", 9000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
