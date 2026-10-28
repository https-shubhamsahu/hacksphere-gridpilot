"""Optional proxy to a Zoho Catalyst QuickML published endpoint (stdlib urllib only).

Configured through environment variables (never committed):
  QUICKML_ENDPOINT_URL   published QuickML endpoint URL
  QUICKML_ENDPOINT_KEY   endpoint key (sent as X-QuickML-Endpoint-Key)
  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN   OAuth self-client creds
  ZOHO_ACCOUNTS_URL      default https://accounts.zoho.in
  CATALYST_ORG_ID        sent as CATALYST-ORG header
  QUICKML_ENVIRONMENT    sent as Environment header (default Development)

predict_quickml(rows) returns a list of floats or raises QuickMLError; the app
falls back to the local model on any error. build_payload / parse_response are
kept small so they are easy to adapt once the exact endpoint schema is known.
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .features import quickml_row_features

TIMEOUT_S = 20
BATCH = 1  # Catalyst QuickML endpoints take one feature row per request
_token_lock = threading.Lock()
_token = {"value": None, "expires": 0.0}


class QuickMLError(Exception):
    pass


def _env(name, default=None):
    v = os.environ.get(name, default)
    return v.strip() if isinstance(v, str) else v


def is_configured():
    """True only when every credential the endpoint requires is present."""
    return bool(_env("QUICKML_ENDPOINT_URL") and _env("QUICKML_ENDPOINT_KEY") and _has_oauth())


def _has_oauth():
    return all(_env(k) for k in ("ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"))


def get_access_token():
    """Refresh-token grant against Zoho Accounts; cached until shortly before expiry."""
    if not _has_oauth():
        return None
    with _token_lock:
        if _token["value"] and time.time() < _token["expires"] - 60:
            return _token["value"]
        base = _env("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.in").rstrip("/")
        data = urllib.parse.urlencode({
            "refresh_token": _env("ZOHO_REFRESH_TOKEN"),
            "client_id": _env("ZOHO_CLIENT_ID"),
            "client_secret": _env("ZOHO_CLIENT_SECRET"),
            "grant_type": "refresh_token",
        }).encode()
        req = urllib.request.Request(base + "/oauth/v2/token", data=data, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise QuickMLError("token refresh failed: %s" % e)
        tok = body.get("access_token")
        if not tok:
            raise QuickMLError("token refresh returned no access_token: %s" % str(body)[:200])
        _token["value"] = tok
        _token["expires"] = time.time() + float(body.get("expires_in", 3600))
        return tok


def build_payload(rows):
    """rows: cleaned dicts (timestamp str + 3 weather floats) -> request JSON.
    Feature columns are exactly those QuickML was trained on (quickml_train.csv)."""
    feats = [quickml_row_features(r["timestamp"], float(r["ambient_temp_c"]),
                                  float(r["humidity_pct"]), float(r["solar_irradiance_wm2"]))
             for r in rows]
    return {"data": feats[0] if len(feats) == 1 else feats}


_VALUE_KEYS = ("prediction", "predicted_value", "target_demand_kw", "predicted_target_demand_kw",
               "value", "result", "output", "score")


def _as_number(item):
    if isinstance(item, bool):
        raise QuickMLError("boolean prediction")
    if isinstance(item, (int, float)):
        return float(item)
    if isinstance(item, str):
        return float(item)
    if isinstance(item, dict):
        for k in _VALUE_KEYS:
            if k in item:
                return _as_number(item[k])
        nums = [v for v in item.values() if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if len(nums) == 1:
            return float(nums[0])
        for v in item.values():
            if isinstance(v, (str, dict, list)):
                try:
                    return _as_number(v)
                except (QuickMLError, ValueError, TypeError):
                    continue
    if isinstance(item, list) and len(item) == 1:
        return _as_number(item[0])
    raise QuickMLError("cannot read a number from %r" % (str(item)[:80],))


def parse_response(body, expected):
    """Accepts {"predictions":[...]}, {"data":[...]}, {"result":[...]}, {"output":[...]},
    nested {"data":{"predictions":[...]}}, or a bare list of numbers / dicts."""
    seq = body
    for _ in range(3):
        if isinstance(seq, dict):
            for k in ("predictions", "prediction", "data", "result", "results", "output", "outputs"):
                if k in seq:
                    seq = seq[k]
                    break
            else:
                break
        else:
            break
    if not isinstance(seq, list):
        raise QuickMLError("unexpected response shape: %s" % str(body)[:200])
    vals = [_as_number(x) for x in seq]
    if len(vals) != expected:
        raise QuickMLError("expected %d predictions, got %d" % (expected, len(vals)))
    for v in vals:
        if v != v or v in (float("inf"), float("-inf")):
            raise QuickMLError("non-finite prediction")
    return vals


def _post(url, payload):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    key = _env("QUICKML_ENDPOINT_KEY")
    if key:
        headers["X-QuickML-Endpoint-Key"] = key
    org = _env("CATALYST_ORG_ID")
    if org:
        headers["CATALYST-ORG"] = org
    headers["Environment"] = _env("QUICKML_ENVIRONMENT", "Development")
    tok = get_access_token()
    if tok:
        headers["Authorization"] = "Zoho-oauthtoken " + tok
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise QuickMLError("endpoint call failed: %s" % e)


def predict_quickml(rows):
    if not is_configured():
        raise QuickMLError("QuickML not configured")
    url = _env("QUICKML_ENDPOINT_URL")
    chunks = [rows[i:i + BATCH] for i in range(0, len(rows), BATCH)]
    get_access_token()  # refresh once up front, not once per worker

    def score(chunk):
        return parse_response(_post(url, build_payload(chunk)), len(chunk))

    # One row per request, so fan out; map() keeps the input order.
    workers = max(1, min(int(_env("QUICKML_WORKERS", "16")), len(chunks)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(score, chunks))
    return [p for chunk_preds in results for p in chunk_preds]
