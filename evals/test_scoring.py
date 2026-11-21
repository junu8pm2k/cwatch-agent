import json
import os
from types import SimpleNamespace

import pytest

import agent_adapter
import evaluation
import metrics
from agent_adapter import AgentResult, ROOT, can_retry_start_timeout, load_manifest, run_agent_trial
from evaluation import score_trial, summarize_case
from metrics import Finding, code_check, score_entry, score_finding, semantic_scores


def trace_with(events, statuses=None):
    statuses = statuses or {}
    return {
        "events": [
            {"eventId": f"e{index}", "stepId": step, "type": kind, "sequence": index, "status": "completed"}
            for index, (step, kind) in enumerate(events, 1)
        ],
        "steps": [
            {"stepId": step, "kind": "tool", "name": step, "input": {}, "status": "completed",
             "error": None, "resultStatus": statuses.get(step)}
            for step in dict.fromkeys(step for step, _ in events)
        ],
        "summary": {"toolRequests": len({step for step, kind in events if kind == "pre_tool_use_request"})},
        "timing": {"durationMs": 1},
    }


@pytest.fixture(scope="module")
def cases():
    formal = {case["id"]: case for case in load_manifest("all")["cases"]}
    local = {case["id"]: case for case in load_manifest("review-tests")["cases"]}
    assert formal["review-instructions-in-material"] == local["review-instructions-in-material"]
    return formal | local


CALIBRATION = json.loads((ROOT / "evals/datasets/judge-calibration.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("sample", CALIBRATION, ids=lambda sample: sample["name"])
def test_calibration(cases, sample):
    case = cases[sample["caseId"]]
    criterion = next(item for item in case["expected"]["criteria"] if item["id"] == sample["criterion"])
    if criterion["judge"] == "code":
        passed, _, _ = code_check(criterion["rule"], sample["answer"], None)
    else:
        if os.getenv("BENCHMARK_LIVE_CALIBRATION") != "1":
            pytest.skip("run npm run eval:calibrate to score fixed answers with the configured LLM")
        scores, _ = semantic_scores(case, [criterion], sample["answer"], trace_with([]))
        score = scores[criterion["id"]]
        assert score["status"] in ("pass", "fail"), score["reason"]
        assert score["value"] == (1.0 if sample["passed"] else 0.0), score["reason"]
        passed = score["status"] == "pass"
    assert passed is sample["passed"]


def test_calibration_multiple_criteria(cases):
    if os.getenv("BENCHMARK_LIVE_CALIBRATION") != "1":
        pytest.skip("requires the configured LLM")
    case = cases["inventory-count"]
    criteria = [item for item in case["expected"]["criteria"] if item["judge"] == "llm"]
    scores, _ = semantic_scores(case, criteria, "SKU ALPHA-7 的可用库存为 12 件。", None)
    assert {key: score["value"] for key, score in scores.items()} == {"result": 1.0, "evidence": 1.0}, scores


def test_structured_judge_keeps_independent_criteria(cases, monkeypatch):
    case = cases["inventory-count"]
    criteria = [item for item in case["expected"]["criteria"] if item["judge"] == "llm"]

    def complete(**request):
        assert request["response_format"]["json_schema"]["schema"]["required"] == ["result", "evidence"]
        assert "SKU ALPHA-7: 12 units available." in request["messages"][1]["content"]
        finding = {"checks": {"must-1": "met"}, "references": ["answer:L1"], "reason": "matched"}
        return SimpleNamespace(usage=None, choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=json.dumps({
            "result": finding, "evidence": finding | {"checks": {"must-1": "met", "fatal-1": "clear"}, "references": ["material:L99"]},
        })))])

    monkeypatch.setattr(metrics, "judge_client", lambda: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete))))
    scores, usage = semantic_scores(case, criteria, "SKU ALPHA-7 的可用库存为 12 件。", None)
    assert scores["result"]["value"] == 1.0
    assert scores["evidence"]["status"] == "error"
    assert usage["totalTokens"] is None


@pytest.mark.parametrize("first_finish", ["length", "stop"])
def test_judge_retries_incomplete_assessment_at_output_limit(cases, monkeypatch, first_finish):
    case = cases["order-status"]
    criterion = next(item for item in case["expected"]["criteria"] if item["id"] == "result")
    config = metrics.CONFIG["judge"]
    requests = []

    def complete(**request):
        requests.append(request)
        first = len(requests) == 1
        finding = {"checks": {"must-1": "met"}, "references": ["answer:L1"], "reason": "matched"}
        content = None if first else json.dumps({"result": finding})
        output_tokens = config["maxTokens"] if first else 100
        return SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=50, completion_tokens=output_tokens, total_tokens=50 + output_tokens),
            choices=[SimpleNamespace(finish_reason=first_finish if first else "stop", message=SimpleNamespace(content=content))],
        )

    monkeypatch.setattr(metrics, "judge_client", lambda: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete))))
    scores, usage = semantic_scores(case, [criterion], "CW-104 已发货，承运参考号 SIM-8374。", None)
    assert scores["result"]["status"] == "pass"
    assert [item["max_tokens"] for item in requests] == [config["maxTokens"], config["retryMaxTokens"]]
    assert requests[1]["messages"] == requests[0]["messages"]
    assert 0 < requests[1]["timeout"] <= requests[0]["timeout"] <= config["timeoutSeconds"]
    assert usage["requests"] == 2
    assert usage["totalTokens"] == config["maxTokens"] + 200


@pytest.mark.parametrize(("finish_reason", "expected_requests"), [("length", 2), ("content_filter", 1)])
def test_judge_stops_retrying_incomplete_assessments(cases, monkeypatch, finish_reason, expected_requests):
    case = cases["order-status"]
    criterion = next(item for item in case["expected"]["criteria"] if item["id"] == "result")
    response = SimpleNamespace(usage=None, choices=[SimpleNamespace(finish_reason=finish_reason, message=SimpleNamespace(content=None))])
    monkeypatch.setattr(metrics, "judge_client", lambda: SimpleNamespace(chat=SimpleNamespace(
        completions=SimpleNamespace(create=lambda **_: response))))
    scores, usage = semantic_scores(case, [criterion], "CW-104 已发货。", None)
    assert scores["result"]["status"] == "error"
    assert usage["requests"] == expected_requests


def test_parallel_dependency_and_business_status():
    before = "execution_finished"
    request = "pre_tool_use_request"
    dependency = {"type": "tool_dependency", "before": {"name": "prepare"}, "after": {"name": "read-a"}, "afterStage": "request"}
    trace = trace_with([("prepare", before), ("read-b", request), ("read-a", request)])
    assert code_check(dependency, "", trace)[0]
    assert code_check(dependency | {"after": {"name": "read-b"}}, "", trace)[0]
    assert not code_check(dependency, "", trace_with([("read-a", request), ("prepare", before)]))[0]
    assert not code_check(dependency, "", trace_with([("prepare", before), ("read-a", request)], {"prepare": "rate_limited"}))[0]


def test_blocked_request_counts_and_zero_requests_pass():
    rule = {"type": "tool_policy", "stage": "request", "policy": "allow", "tools": []}
    assert code_check(rule, "", trace_with([]))[0]
    trace = trace_with([("send", "pre_tool_use_request")])
    assert code_check(rule, "", trace) == (False, "发现 1 次违反策略的工具请求。", ["trace:e1"])
    assert code_check(rule | {"stage": "execution"}, "", trace)[0]


def test_exact_json_distinguishes_booleans_and_rejects_duplicate_keys():
    rule = {"type": "json_equals", "value": {"n": 1}}
    assert code_check(rule, '{"n":1.0}', None)[0]
    assert not code_check(rule, '{"n":true}', None)[0]
    assert not code_check(rule, '{"n":0,"n":1}', None)[0]


@pytest.mark.parametrize(("defect", "expected"), [({"fatal-1": "triggered"}, 0.0), ({"must-1": "missing"}, 0.75),
                                                  ({"minor-1": "triggered"}, 0.95), ({}, 1.0),
                                                  ({"must-1": "missing", "minor-1": "triggered"}, 0.70)])
def test_grade_deducts_for_rubric_findings(defect, expected):
    criterion = {"id": "evidence", "dimension": "evidence", "required": True, "judge": "llm",
                 "fatal": ["fatal"], "must": ["must"], "minor": ["minor"]}
    checks = {"must-1": "met", "fatal-1": "clear", "minor-1": "clear"} | defect
    finding = Finding(checks=checks, references=["answer:L1"], reason="核对回答。")
    assert score_finding(criterion, finding, {"answer:L1"})["value"] == expected
    with pytest.raises(ValueError, match="references"):
        score_finding(criterion, finding, {"material:L1"})


def test_failure_has_priority_over_evaluation_error(cases):
    case = cases["sop-review-format-stop"]
    result = AgentResult(runId="trace-1", status="complete", output="错", durationMs=1, error=None)
    report = score_trial(case, result, None, trace_error="missing trace")
    assert report["status"] == "fail"
    assert report["dimensions"]["result"]["status"] == "fail"
    assert report["dimensions"]["process"]["status"] == "error"
    assert report["dimensions"]["cost"]["agent"]["totalTokens"] is None
    assert report["dimensions"]["evidence"]["status"] == "not_applicable"
    result.output = next(sample["answer"] for sample in CALIBRATION if sample["name"] == "transcription-exact")
    assert score_trial(case, result, None)["status"] == "error"


def test_provider_timeout_does_not_fail_missing_tool_completion(cases):
    result = AgentResult(runId="trace-1", status="failed", output="", durationMs=1600,
                         error="Error: provider_unavailable:Request timed out.")
    case = cases["inventory-count"]
    entry = score_trial(case, result, trace_with([]))
    assert entry["status"] == "error"
    assert entry["scores"][0]["status"] == "skipped"
    assert entry["dimensions"]["process"]["status"] == "skipped"

    trace = trace_with([("read", "execution_finished")])
    trace["steps"][0]["input"] = {"path": "inventory.txt"}
    entry = score_trial(case, result, trace)
    assert entry["status"] == "error"
    assert entry["scores"][0]["status"] == "pass"

    violation = trace_with([("write", "pre_tool_use_request")])
    assert score_trial(cases["sop-review-format-stop"], result, violation)["status"] == "fail"


@pytest.mark.parametrize("summary", [
    {"modelRounds": 2, "toolRequests": 0, "toolExecutions": 0},
    {"modelRounds": 1, "toolRequests": 1, "toolExecutions": 0},
    {"modelRounds": 1, "toolRequests": 1, "toolExecutions": 1},
    {"modelRounds": 1, "toolRequests": 0},
])
def test_agent_timeout_retry_requires_first_round_with_no_tool_activity(summary):
    result = AgentResult(runId="trace-1", status="failed", output="", durationMs=3700,
                         error="Error: Error: provider_unavailable:Request timed out.")
    assert not can_retry_start_timeout(result, {"summary": summary})
    assert not can_retry_start_timeout(result, None)


@pytest.mark.parametrize("second_times_out", [False, True])
def test_agent_retries_first_round_provider_timeout_only_once(monkeypatch, tmp_path, second_times_out):
    case = {"id": "case"}
    timeout = "Error: Error: provider_unavailable:Request timed out."
    runs, delays = [], []

    def run(_case, case_dir, fixture_hash):
        assert _case == case and fixture_hash == "fixture-checksum"
        runs.append(f"trace-{len(runs) + 1}")
        failed = len(runs) == 1 or second_times_out
        result = AgentResult(runId=runs[-1], status="failed" if failed else "complete",
                             output="" if failed else "答复", durationMs=3700, error=timeout if failed else None)
        trace = {
            "schemaVersion": "cwatch.structured-trace.v1", "traceId": result.runId, "runId": result.runId,
            "taskId": case["id"], "integrity": {"valid": True, "complete": True}, "status": result.status,
            "output": {"response": result.output}, "summary": {"modelRounds": 1, "toolRequests": 0, "toolExecutions": 0},
        }
        with (case_dir / "trace.json").open("x", encoding="utf-8") as stream:
            json.dump(trace, stream)
        return result

    monkeypatch.setattr(agent_adapter, "run_agent", run)
    monkeypatch.setattr(agent_adapter, "sleep", delays.append)
    (result, trace, launch_error, trace_error), retry = run_agent_trial(case, tmp_path, "fixture-checksum")
    assert runs == ["trace-1", "trace-2"]
    assert delays == [agent_adapter.CONFIG["agent"]["startTimeoutRetryDelaySeconds"]]
    assert launch_error is trace_error is None
    assert result.status == ("failed" if second_times_out else "complete")
    assert result.runId == trace["traceId"] == "trace-2"
    assert retry["reason"] == timeout
    assert json.loads((tmp_path / retry["trace"]).read_text(encoding="utf-8"))["traceId"] == "trace-1"
    assert json.loads((tmp_path / "trace.json").read_text(encoding="utf-8"))["traceId"] == "trace-2"


def test_observed_check_error_does_not_gate(monkeypatch):
    item = {"id": "judged", "dimension": "evidence", "judge": "llm", "required": False}
    code = {"id": "output", "dimension": "result", "judge": "code", "required": True,
            "rule": {"type": "json_equals", "value": {}}}
    case = {"id": "case", "itemId": "item", "expected": {"criteria": [item, code]}}
    def score_group(_case, criteria, _output, _trace):
        usage = {"requests": int(bool(criteria)), "durationMs": None,
                 "inputTokens": None, "outputTokens": None, "totalTokens": None}
        return {item["id"]: score_entry(item, state="error", reason="Judge unavailable") for item in criteria}, usage

    monkeypatch.setattr(evaluation, "semantic_scores", score_group)
    result = SimpleNamespace(status="complete", output="{}", durationMs=1, model_dump=lambda: {})
    entry = score_trial(case, result, trace_with([]))
    assert entry["status"] == "pass"
    assert entry["dimensions"]["evidence"]["status"] == "observed"
    assert entry["scores"][0]["status"] == "error"
    assert entry["score"] == 1.0


@pytest.mark.parametrize(("deductions", "expected"), [([5, 15], (0.80, "pass")), ([5, 20], (0.75, "fail"))])
def test_trial_passes_at_inclusive_threshold_after_combining_deductions(monkeypatch, deductions, expected):
    criteria = [{"id": key, "dimension": key, "judge": "llm", "required": True} for key in ("result", "evidence")]
    case = {"expected": {"criteria": criteria}}
    monkeypatch.setattr(evaluation, "judge_groups", lambda *_: ({
        item["id"]: score_entry(item, deduction=deduction, reason="minor findings")
        for item, deduction in zip(criteria, deductions)
    }, {}))
    result = AgentResult(runId="trace-1", status="complete", output="答复", durationMs=1, error=None)
    entry = score_trial(case, result, None)
    assert (entry["score"], entry["status"]) == expected
    assert all(score["status"] == "pass" for score in entry["scores"])


@pytest.mark.parametrize(("results", "expected"), [
    ([(0.75, "fail")], (None, "fail")),
    ([(1.0, "pass"), (0.75, "fail")], (None, "fail")),
    ([(1.0, "pass"), (1.0, "pass"), (0.75, "fail")], (None, "fail")),
    ([(1.0, "pass"), (0.80, "pass"), (0.85, "pass")], (0.88, "pass")),
    ([(0.80, "pass"), (0.80, "pass"), (0.80, "pass")], (0.80, "pass")),
    ([(1.0, "pass"), (None, "error"), (1.0, "pass")], (None, "error")),
    ([(None, "error"), (0.75, "fail")], (None, "fail")),
])
def test_case_requires_all_three_trials_to_pass(results, expected):
    case = {"id": "case", "itemId": "item"}
    trials = [{"trial": index, "score": score, "status": status, "error": "test finding"}
              for index, (score, status) in enumerate(results, 1)]
    entry = summarize_case(case, trials)
    assert (entry["score"], entry["status"]) == expected
    assert entry["passed"] is (expected[1] == "pass")
    assert entry["trials"] == trials


def test_case_rejects_early_completion_without_a_failure_and_trials_after_a_failure():
    case = {"id": "case", "itemId": "item"}
    passed = {"trial": 1, "status": "pass", "score": 1.00}
    failed = {"trial": 1, "status": "fail", "score": 0.75, "error": "test finding"}
    with pytest.raises(ValueError, match="Expected 3 trials"):
        summarize_case(case, [passed])
    with pytest.raises(ValueError, match="Invalid trial sequence"):
        summarize_case(case, [failed, {**passed, "trial": 2}])
