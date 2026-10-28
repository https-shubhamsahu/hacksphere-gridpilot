"""Transition-rule boundary tests. Run: python tests/test_controller.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "appsail"))
from gridpilot.controller import GRID, STORAGE, decide, run_controller  # noqa: E402


def row(ts, irr=0.0):
    return {"timestamp": ts, "ambient_temp_c": 30.0, "humidity_pct": 50.0, "solar_irradiance_wm2": irr}


class DecideTests(unittest.TestCase):
    def test_160_exact_outside_window_is_grid(self):
        mode, alert, reasons = decide(160.0, 12)
        self.assertEqual(mode, GRID)
        self.assertFalse(alert)

    def test_160_01_is_storage(self):
        mode, alert, reasons = decide(160.01, 12)
        self.assertEqual(mode, STORAGE)
        self.assertFalse(alert)
        self.assertTrue(any("> 160" in r for r in reasons))

    def test_200_triggers_alert(self):
        mode, alert, _ = decide(200.0, 3)
        self.assertEqual(mode, STORAGE)
        self.assertTrue(alert)

    def test_199_99_no_alert(self):
        self.assertFalse(decide(199.99, 3)[1])

    def test_alert_independent_of_window(self):
        self.assertTrue(decide(250.0, 19)[1])
        self.assertTrue(decide(250.0, 10)[1])

    def test_hour_boundaries_low_demand(self):
        self.assertEqual(decide(100.0, 17)[0], GRID)
        self.assertEqual(decide(100.0, 18)[0], STORAGE)
        self.assertEqual(decide(100.0, 22)[0], STORAGE)
        self.assertEqual(decide(100.0, 23)[0], GRID)
        self.assertEqual(decide(160.0, 17)[0], GRID)
        self.assertEqual(decide(160.0, 23)[0], GRID)

    def test_window_reason(self):
        self.assertTrue(any("18:00-22:00" in r for r in decide(100.0, 20)[2]))


class RunControllerTests(unittest.TestCase):
    def test_signals_summary_and_soc(self):
        rows = [row("2015-06-16 16:00:00", 300), row("2015-06-16 17:00:00", 100),
                row("2015-06-16 18:00:00"), row("2015-06-16 19:00:00"), row("2015-06-16 23:00:00")]
        preds = [150.0, 160.0, 210.0, 120.0, 165.0]
        out, summary, signals = run_controller(rows, preds, {"capacity_kwh": 500, "initial_soc_pct": 80})
        self.assertEqual([r["grid_mode"] for r in out], [GRID, GRID, STORAGE, STORAGE, STORAGE])
        self.assertEqual([r["overload_alert"] for r in out], [False, False, True, False, False])
        self.assertEqual(summary["transitions"], 1)
        self.assertEqual(summary["storage_hours"], 3)
        self.assertEqual(summary["grid_hours"], 2)
        self.assertEqual(summary["overload_hours"], 1)
        self.assertEqual(summary["peak_demand_kw"], 210.0)
        self.assertEqual(summary["peak_hour"], "2015-06-16 18:00:00")
        events = [s["event"] for s in signals]
        self.assertEqual(events, ["SWITCH_TO_GRID", "SWITCH_TO_STORAGE", "OVERLOAD_ALERT"])
        for r in out:
            self.assertTrue(10.0 <= r["battery_soc_pct"] <= 100.0)
        # grid hours charge, storage hours discharge
        self.assertGreater(out[1]["battery_soc_pct"], 80.0)
        self.assertLess(out[2]["battery_soc_pct"], out[1]["battery_soc_pct"])
        self.assertAlmostEqual(out[0]["solar_generation_kw"], 36.0)

    def test_soc_floor(self):
        rows = [row("2015-06-16 19:00:00")] * 10
        out, summary, _ = run_controller(rows, [250.0] * 10, {"capacity_kwh": 100, "initial_soc_pct": 50})
        self.assertAlmostEqual(summary["min_soc_pct"], 10.0)
        self.assertTrue(all(r["grid_mode"] == STORAGE for r in out))


if __name__ == "__main__":
    unittest.main(verbosity=2)
