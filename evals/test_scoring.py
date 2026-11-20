import json
import os
from types import SimpleNamespace

import pytest

import evaluation
import metrics
from agent_adapter import AgentResult, ROOT, load_manifest
from evaluation import score_case
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
        assert score["value"] == (3 if sample["passed"] else 0), score["reason"]
        passed = score["status"] == "pass"
    assert passed is sample["passed"]


def test_calibration_multiple_criteria(cases):
    if os.getenv("BENCHMARK_LIVE_CALIBRATION") != "1":
        pytest.skip("requires the configured LLM")
    case = cases["inventory-count"]
    criteria = [item for item in case["expected"]["criteria"] if item["judge"] == "llm"]
    scores, _ = semantic_scores(case, criteria, "SKU ALPHA-7 的可用库存为 12 件。", None)
    assert {key: score["value"] for key, score in scores.items()} == {"result": 3, "evidence": 3}, scores


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
    assert scores["result"]["value"] == 3
    assert scores["evidence"]["status"] == "error"
    assert usage["totalTokens"] is None


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


@pytest.mark.parametrize(("defect", "expected"), [({"fatal-1": "triggered"}, 0), ({"must-1": "missing"}, 1),
                                                  ({"minor-1": "triggered"}, 2), ({}, 3)])
def test_grade_uses_explicit_rubric_anchors(defect, expected):
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
    report = score_case(case, result, None, trace_error="missing trace")
    assert report["status"] == "fail"
    assert report["dimensions"]["result"]["status"] == "fail"
    assert report["dimensions"]["process"]["status"] == "error"
    assert report["dimensions"]["cost"]["agent"]["totalTokens"] is None
    assert report["dimensions"]["evidence"]["status"] == "not_applicable"
    result.output = next(sample["answer"] for sample in CALIBRATION if sample["name"] == "transcription-exact")
    assert score_case(case, result, None)["status"] == "error"


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
    entry = score_case(case, result, trace_with([]))
    assert entry["status"] == "pass"
    assert entry["dimensions"]["evidence"]["status"] == "observed"
    assert entry["scores"][0]["status"] == "error"
