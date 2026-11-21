import os
from pathlib import Path

import pytest

from agent_adapter import load_manifest, load_trace, run_agent
from evaluation import TRIAL_COUNT, score_trial, summarize_case
from reporting import BenchmarkReport

if os.getenv("API_KEY") or os.getenv("CONFIDENT_API_KEY"):
    raise RuntimeError("Run through npm run eval:run, eval:docker or eval:ci to isolate model credentials.")

SUITE = os.getenv("BENCHMARK_SUITE") or "smoke"
if SUITE not in ("all", "smoke", "regression", "review-tests"):
    raise ValueError("BENCHMARK_SUITE must be all, smoke, regression or review-tests")
MANIFEST = load_manifest(SUITE)
CASES = [case for case in MANIFEST["cases"] if SUITE in ("all", "review-tests") or SUITE in case["tags"]]
REVIEW_CASE_ID = os.getenv("BENCHMARK_REVIEW_CASE_ID")
if SUITE == "review-tests" and REVIEW_CASE_ID:
    CASES = [case for case in CASES if case["id"] == REVIEW_CASE_ID]
    if not CASES:
        raise ValueError(f"Unknown review test case: {REVIEW_CASE_ID}")


@pytest.fixture(scope="session")
def report():
    return BenchmarkReport(Path(os.environ["BENCHMARK_RUN_DIR"]), MANIFEST, SUITE, CASES)


def run_trial(case, report, trial):
    case_dir = report.trial_dir(case["id"], trial)
    result = trace = launch_error = trace_error = None
    try:
        result = run_agent(case, case_dir, MANIFEST["fixtureHashes"][case["fixture"]])
    except (OSError, RuntimeError, ValueError) as error:
        launch_error = str(error)
    if result is not None:
        try:
            trace = load_trace(case, case_dir, result)
        except (OSError, KeyError, TypeError, ValueError) as error:
            trace_error = str(error)
    return {"trial": trial, **score_trial(case, result, trace, launch_error=launch_error, trace_error=trace_error)}


@pytest.fixture
def verdict(case, report, record_property):
    trials = []
    for trial in range(1, TRIAL_COUNT + 1):
        result = run_trial(case, report, trial)
        trials.append(result)
        if result["status"] == "fail":
            break
    entry = summarize_case(case, trials)
    report.record(entry)
    record_property("benchmark_status", entry["status"])
    if entry["score"] is not None:
        record_property("benchmark_score", f'{entry["score"]:.2f}')
    if entry["status"] == "error":
        pytest.fail(entry["error"], pytrace=False)
    return entry


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_benchmark_case(verdict):
    if verdict["status"] == "fail":
        pytest.fail(verdict["error"], pytrace=False)
