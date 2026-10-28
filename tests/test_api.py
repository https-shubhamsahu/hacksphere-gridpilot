"""API tests with Flask's test client. Run: python tests/test_api.py"""
import io
import json
import math
import os
import sys
import unittest

APPSAIL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "appsail")
sys.path.insert(0, APPSAIL)
os.environ.pop("QUICKML_ENDPOINT_URL", None)
import app as gp_app  # noqa: E402
from gridpilot import quickml  # noqa: E402

ROW_KEYS = {"timestamp", "ambient_temp_c", "humidity_pct", "solar_irradiance_wm2", "predicted_demand_kw",
            "grid_mode", "overload_alert", "reasons", "battery_soc_pct", "solar_generation_kw"}
SUMMARY_KEYS = {"peak_demand_kw", "peak_hour", "avg_demand_kw", "total_energy_kwh", "storage_hours",
                "grid_hours", "overload_hours", "transitions", "min_soc_pct"}

MESSY_CSV = """timestamp,ambient_temp_c,humidity_pct,solar_irradiance_wm2,target_demand_kw
2015-06-16 15:00:00,35.66,56.38,169.0,200
16-06-2015 16:00,,54.73,112.0,1
2015/06/16 17:00,34.35,149.34,-5,1
not-a-date,30,50,0,1
2015-06-16T18:00:00,35.37,,16.0,1
2015-06-16 19:00:00,abc,60,0,1
2015-06-16 19:00:00,33.0,60,0,1
2015-06-16 20:00:00,32.0,61,0,1
"""


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = gp_app.app.test_client()

    def sample(self):
        r = self.c.get("/api/sample")
        self.assertEqual(r.status_code, 200)
        return r.get_json()["data"]

    def test_health(self):
        r = self.c.get("/api/health")
        j = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(j["status"], "ok")
        self.assertEqual(set(j), {"status", "model", "model_version", "validation_rmse", "quickml_configured", "time"})
        self.assertIsInstance(j["validation_rmse"], float)
        self.assertFalse(j["quickml_configured"])
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")

    def test_options_preflight(self):
        r = self.c.open("/api/predict", method="OPTIONS")
        self.assertIn(r.status_code, (200, 204))
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")

    def test_sample(self):
        data = self.sample()
        self.assertEqual(len(data), 24)
        self.assertEqual(data[0]["timestamp"], "2015-06-16 15:00:00")

    def test_predict_sample_and_1000_rows(self):
        data = self.sample()
        r = self.c.post("/api/predict", json={"data": data})
        j = r.get_json()
        self.assertEqual(j["source"], "local")
        self.assertEqual(len(j["predictions"]), 24)
        import csv
        root = os.path.dirname(APPSAIL)
        with open(os.path.join(root, "sample_test_input.csv")) as f:
            rows = list(csv.DictReader(f))
        r = self.c.post("/api/predict", json={"data": rows})
        preds = r.get_json()["predictions"]
        self.assertEqual(len(preds), 1000)
        self.assertTrue(all(isinstance(p, float) and math.isfinite(p) for p in preds))

    def test_predict_keeps_rows_one_to_one(self):
        rows = [{"timestamp": "2015-06-16 15:00:00", "ambient_temp_c": 35, "humidity_pct": 56, "solar_irradiance_wm2": 169},
                {"timestamp": "garbage", "ambient_temp_c": None, "humidity_pct": "x", "solar_irradiance_wm2": 1},
                {"timestamp": "2015-06-16 15:00:00", "ambient_temp_c": 35, "humidity_pct": 56, "solar_irradiance_wm2": 169},
                {"timestamp": "2015-06-16 12:00:00", "ambient_temp_c": 30, "humidity_pct": 50, "solar_irradiance_wm2": 400}]
        preds = self.c.post("/api/predict", json={"data": rows}).get_json()["predictions"]
        self.assertEqual(len(preds), 4)
        self.assertEqual(preds[0], preds[2])
        self.assertTrue(all(math.isfinite(p) for p in preds))

    def test_predict_bad_body(self):
        self.assertEqual(self.c.post("/api/predict", data="nope", content_type="text/plain").status_code, 400)

    def test_forecast_contract(self):
        data = self.sample()
        r = self.c.post("/api/forecast", json={"data": data, "battery": {"capacity_kwh": 500, "initial_soc_pct": 80}})
        j = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(j), {"rows", "summary", "signals", "cleaning", "model_source"})
        self.assertEqual(len(j["rows"]), 24)
        self.assertEqual(set(j["rows"][0]), ROW_KEYS)
        self.assertEqual(set(j["summary"]), SUMMARY_KEYS)
        for row in j["rows"]:
            d, hour = row["predicted_demand_kw"], int(row["timestamp"][11:13])
            want = "RENEWABLE_STORAGE" if (d > 160 or 18 <= hour <= 22) else "MAIN_GRID"
            self.assertEqual(row["grid_mode"], want)
            self.assertEqual(row["overload_alert"], d >= 200)
        self.assertEqual(j["cleaning"]["rows_in"], 24)
        self.assertEqual(j["cleaning"]["dropped"], 0)
        # forecast predictions == predict predictions
        p = self.c.post("/api/predict", json={"data": data}).get_json()["predictions"]
        for a, b in zip(p, [r["predicted_demand_kw"] for r in j["rows"]]):
            self.assertAlmostEqual(a, b, places=3)

    def test_forecast_csv_messy(self):
        r = self.c.post("/api/forecast/csv", data={"file": (io.BytesIO(MESSY_CSV.encode()), "messy.csv")},
                        content_type="multipart/form-data")
        j = r.get_json()
        self.assertEqual(r.status_code, 200, j)
        cl = j["cleaning"]
        self.assertEqual(cl["rows_in"], 8)
        self.assertEqual(cl["dropped"], 2)  # 1 bad timestamp + 1 duplicate
        self.assertEqual(cl["rows_out"], 6)
        self.assertEqual(cl["imputed"].get("ambient_temp_c"), 1)  # empty; 'abc' row was the dropped duplicate
        self.assertEqual(cl["imputed"].get("humidity_pct"), 1)
        self.assertEqual(cl["clipped"].get("humidity_pct"), 1)
        self.assertEqual(cl["clipped"].get("solar_irradiance_wm2"), 1)
        ts = [r["timestamp"] for r in j["rows"]]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual(ts[1], "2015-06-16 16:00:00")
        self.assertEqual(ts[2], "2015-06-16 17:00:00")
        self.assertEqual(ts[3], "2015-06-16 18:00:00")
        self.assertAlmostEqual(j["rows"][1]["ambient_temp_c"], (35.66 + 34.35) / 2, places=3)
        self.assertEqual(j["rows"][2]["humidity_pct"], 100.0)
        self.assertTrue(cl["warnings"])

    def test_forecast_csv_missing_file(self):
        self.assertEqual(self.c.post("/api/forecast/csv", data={}).status_code, 400)

    def test_forecast_all_bad(self):
        r = self.c.post("/api/forecast", json={"data": [{"timestamp": "x"}]})
        self.assertEqual(r.status_code, 400)

    def test_logs(self):
        self.c.post("/api/forecast", json={"data": self.sample()})
        ev = self.c.get("/api/logs").get_json()["events"]
        self.assertTrue(0 < len(ev) <= 100)
        self.assertTrue(set(e["level"] for e in ev) <= {"INFO", "WARN", "ALERT"})
        self.assertTrue(any(e["level"] == "ALERT" for e in ev))

    def test_quickml_fallback_on_bad_endpoint(self):
        os.environ["QUICKML_ENDPOINT_URL"] = "http://127.0.0.1:9/nothing"
        try:
            j = self.c.post("/api/predict", json={"data": self.sample()}).get_json()
            self.assertEqual(j["source"], "local")
            self.assertEqual(len(j["predictions"]), 24)
            ev = self.c.get("/api/logs").get_json()["events"]
            self.assertTrue(any(e["level"] == "WARN" and "QuickML" in e["message"] for e in ev))
        finally:
            os.environ.pop("QUICKML_ENDPOINT_URL", None)

    def test_quickml_response_parser(self):
        self.assertEqual(quickml.parse_response({"predictions": [1, 2]}, 2), [1.0, 2.0])
        self.assertEqual(quickml.parse_response({"data": [{"prediction": 3}]}, 1), [3.0])
        self.assertEqual(quickml.parse_response({"result": ["4.5"]}, 1), [4.5])
        self.assertEqual(quickml.parse_response({"result": [197.8936], "explanation": {}}, 1), [197.8936])
        self.assertEqual(quickml.parse_response([{"target_demand_kw": 7}], 1), [7.0])
        self.assertEqual(quickml.parse_response({"data": {"predictions": [8]}}, 1), [8.0])
        with self.assertRaises(quickml.QuickMLError):
            quickml.parse_response({"predictions": [1]}, 2)
        payload = quickml.build_payload([{"timestamp": "2015-06-16 18:00:00", "ambient_temp_c": 30.0,
                                          "humidity_pct": 50.0, "solar_irradiance_wm2": 0.0}])
        self.assertEqual(payload["data"]["is_evening_peak"], 1)
        self.assertEqual(payload["data"]["cooling_degree"], 8.0)

    def test_static_index(self):
        r = self.c.get("/")
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
