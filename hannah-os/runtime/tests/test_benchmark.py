"""Unit tests for descriptive simulation benchmark statistics; no sockets are opened."""
import unittest

from hannah_edge.benchmark import percentile, summarize


class BenchmarkStatistics(unittest.TestCase):
    def test_nearest_rank_percentiles_are_deterministic(self):
        self.assertEqual(percentile([5, 1, 4, 2, 3], 50), 3)
        self.assertEqual(percentile([5, 1, 4, 2, 3], 95), 5)
        self.assertEqual(percentile([], 95), 0)
        with self.assertRaises(ValueError):
            percentile([1], 0)

    def test_summary_names_latency_and_descriptive_throughput_without_thresholds(self):
        result = summarize([2, 4, 6], 0.0123)
        self.assertEqual(result["samples"], 3)
        self.assertEqual(result["medianMs"], 4)
        self.assertEqual(result["p95Ms"], 6)
        self.assertEqual(result["meanMs"], 4)
        self.assertAlmostEqual(result["operationsPerSecond"], 250)
        self.assertEqual(result["controllerCpuSeconds"], 0.0123)
        self.assertNotIn("pass", result)
        with self.assertRaises(ValueError):
            summarize([], 0)


if __name__ == "__main__":
    unittest.main()
