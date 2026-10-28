"""Transition controller + battery state-of-charge simulation (stdlib only).

Rules (per forecast hour, on the predicted demand in kW):
  RENEWABLE_STORAGE  if demand > 160  OR  18 <= hour <= 22 (inclusive)
  MAIN_GRID          otherwise
  overload_alert     if demand >= 200 (independent of mode)

The battery simulation is display-only: it never changes the mode decided above.
"""
from datetime import datetime

STORAGE = "RENEWABLE_STORAGE"
GRID = "MAIN_GRID"
STORAGE_THRESHOLD_KW = 160.0
OVERLOAD_THRESHOLD_KW = 200.0
PEAK_START, PEAK_END = 18, 22

# Battery / PV assumptions (documented in README).
PV_KWP = 150.0            # rooftop/array size, kW peak
PV_DERATE = 0.8           # inverter + temperature + soiling losses
MAX_DISCHARGE_KW = 150.0  # battery inverter limit
MAX_CHARGE_KW = 100.0
SOC_FLOOR_PCT = 10.0
SOC_CEIL_PCT = 100.0
DEFAULT_CAPACITY_KWH = 500.0
DEFAULT_INITIAL_SOC_PCT = 80.0


def decide(demand_kw, hour):
    """Return (grid_mode, overload_alert, reasons)."""
    reasons = []
    over = demand_kw > STORAGE_THRESHOLD_KW
    peak = PEAK_START <= hour <= PEAK_END
    if over:
        reasons.append("demand %.1f kW > %.0f kW" % (demand_kw, STORAGE_THRESHOLD_KW))
    if peak:
        reasons.append("evening peak window %02d:00-%02d:00" % (PEAK_START, PEAK_END))
    mode = STORAGE if (over or peak) else GRID
    if mode == GRID:
        reasons.append("demand %.1f kW <= %.0f kW outside %02d:00-%02d:00" % (
            demand_kw, STORAGE_THRESHOLD_KW, PEAK_START, PEAK_END))
    alert = demand_kw >= OVERLOAD_THRESHOLD_KW
    if alert:
        reasons.append("critical overload: demand %.1f kW >= %.0f kW" % (demand_kw, OVERLOAD_THRESHOLD_KW))
    return mode, alert, reasons


def solar_kw(irradiance_wm2):
    return max(0.0, float(irradiance_wm2)) / 1000.0 * PV_KWP * PV_DERATE


def _num(v, default, lo, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:
        return default
    return min(hi, max(lo, f))


def run_controller(rows, predictions, battery=None):
    """rows: cleaned rows (timestamp str + 3 weather cols); predictions: floats.
    Returns (out_rows, summary, signals)."""
    battery = battery or {}
    cap = _num(battery.get("capacity_kwh"), DEFAULT_CAPACITY_KWH, 1.0, 1e6)
    soc = _num(battery.get("initial_soc_pct"), DEFAULT_INITIAL_SOC_PCT, 0.0, 100.0)
    energy = cap * soc / 100.0
    floor_e, ceil_e = cap * SOC_FLOOR_PCT / 100.0, cap * SOC_CEIL_PCT / 100.0

    out, signals = [], []
    prev_mode = None
    transitions = storage_h = grid_h = overload_h = 0
    peak_kw, peak_ts, total, min_soc = None, None, 0.0, soc
    for r, p in zip(rows, predictions):
        demand = round(float(p), 4)
        ts = r["timestamp"]
        hour = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").hour
        mode, alert, reasons = decide(demand, hour)
        pv = solar_kw(r["solar_irradiance_wm2"])
        if mode == STORAGE:
            storage_h += 1
            need = max(0.0, demand - pv)
            discharge = min(need, MAX_DISCHARGE_KW, max(0.0, energy - floor_e))
            energy -= discharge
            if need - discharge > 1e-9:
                reasons.append("battery limit: %.1f kW shortfall drawn from grid" % (need - discharge))
        else:
            grid_h += 1
            charge = min(MAX_CHARGE_KW, max(0.0, ceil_e - energy))  # solar surplus first, grid tops up
            energy += charge
        soc_now = 100.0 * energy / cap
        min_soc = min(min_soc, soc_now)

        if prev_mode is None or mode != prev_mode:
            if prev_mode is not None:
                transitions += 1
            signals.append({
                "timestamp": ts,
                "event": "SWITCH_TO_STORAGE" if mode == STORAGE else "SWITCH_TO_GRID",
                "detail": ("initial mode: " if prev_mode is None else "") + "; ".join(
                    x for x in reasons if not x.startswith("critical") and not x.startswith("battery")),
            })
        if alert:
            overload_h += 1
            signals.append({"timestamp": ts, "event": "OVERLOAD_ALERT",
                            "detail": "predicted %.1f kW >= %.0f kW" % (demand, OVERLOAD_THRESHOLD_KW)})
        prev_mode = mode
        total += demand
        if peak_kw is None or demand > peak_kw:
            peak_kw, peak_ts = demand, ts
        out.append({
            "timestamp": ts,
            "ambient_temp_c": r["ambient_temp_c"],
            "humidity_pct": r["humidity_pct"],
            "solar_irradiance_wm2": r["solar_irradiance_wm2"],
            "predicted_demand_kw": demand,
            "grid_mode": mode,
            "overload_alert": alert,
            "reasons": reasons,
            "battery_soc_pct": round(soc_now, 2),
            "solar_generation_kw": round(pv, 2),
        })
    n = len(out)
    summary = {
        "peak_demand_kw": round(peak_kw, 2) if peak_kw is not None else 0.0,
        "peak_hour": peak_ts,
        "avg_demand_kw": round(total / n, 2) if n else 0.0,
        "total_energy_kwh": round(total, 2),  # hourly rows: kW x 1 h
        "storage_hours": storage_h,
        "grid_hours": grid_h,
        "overload_hours": overload_h,
        "transitions": transitions,
        "min_soc_pct": round(min_soc, 2),
    }
    return out, summary, signals
