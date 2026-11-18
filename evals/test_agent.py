import os
from pathlib import Path

import pytest

from agent_adapter import CONFIG, load_manifest, run_agent
from metrics import score
from reporting import BenchmarkReport

if os.getenv("API_KEY") or os.getenv("CONFIDENT_API_KEY"):
    raise RuntimeError("Run through npm run eval:run, eval:docker or eval:ci to isolate model credentials.")

SUITE = os.getenv("BENCHMARK_SUITE", "all")
if SUITE not in ("all", "smoke", "regression"):
    raise ValueError("BENCHMARK_SUITE must be all, smoke or regression")
MANIFEST = load_manifest()
CASES = [case for case in MANIFEST["cases"] if SUITE == "all" or SUITE in case["tags"]]


@pytest.fixture(scope="session")
def report():
    return BenchmarkReport(Path(os.environ["BENCHMARK_RUN_DIR"]), MANIFEST, SUITE, CASES)


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_benchmark_case(case, report):
    with report.record(case) as entry:
        if any("rubric" in CONFIG["metrics"][name] for name in case["metrics"]) and not os.getenv("JUDGE_API_KEY", "").strip():
            raise RuntimeError("missing JUDGE_API_KEY")
        result = run_agent(case, report.case_dir(case["id"]))
        entry["agent"] = result.model_dump()
        assert result.status == "complete", result.error or f"Agent status: {result.status}"
        assert result.output.strip(), "Agent returned empty output"
        failures = []
        for name in case["metrics"]:
            try:
                metric = score(name, case, result)
                entry["scores"].append(metric)
                if not metric["passed"]:
                    failures.append(f'{name} {metric["value"]} < {metric["threshold"]}: {metric["reason"]}')
            except Exception as error:
                failures.append(f"{name} failed: {error}")
        assert not failures, "\n".join(failures)
        assert len(entry["scores"]) == len(case["metrics"]), "missing required score"
