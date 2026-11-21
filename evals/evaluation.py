from agent_adapter import CONFIG
from metrics import FULL_SCORE, PASS_SCORE, REQUIRED_DEDUCTION, TRACE_RULES, code_check, score_entry, semantic_scores

DIMENSIONS = ("result", "process", "evidence", "safety", "cost")
AGENT_INFRA_ERRORS = ("provider_unavailable:", "provider_model_error:", "budget_usage_unavailable:")
TRIAL_COUNT = CONFIG["scoring"]["trialsPerCase"]


def execution_status(result, launch_error):
    if result is None:
        return {"status": "error", "reason": launch_error or "Agent did not return a runtime result."}
    if result.status == "complete" and result.output.strip():
        return {"status": "pass", "reason": "Agent completed with a nonempty answer."}
    reason = result.error or ("Agent returned an empty answer." if result.status == "complete" else f"Agent status: {result.status}.")
    status = "error" if any(code in reason for code in AGENT_INFRA_ERRORS) else "fail"
    return {"status": status, "reason": reason}


def aggregate(statuses):
    for status in ("fail", "error", "pass"):
        if status in statuses:
            return status
    return "not_applicable"


def deduction_points(scores):
    return sum(round(item["deduction"] * FULL_SCORE) for item in scores if item["deduction"] is not None)


def judge_groups(case, criteria, output, trace):
    required = [item for item in criteria if item["required"]]
    observed = [item for item in criteria if not item["required"]]
    scores, usage = semantic_scores(case, required, output, trace)
    if observed:
        extra_scores, extra_usage = semantic_scores(case, observed, output, trace)
        scores.update(extra_scores)
        attempts = [group for group in (usage, extra_usage) if group["requests"]]
        measured = [group["durationMs"] for group in (usage, extra_usage) if group["durationMs"] is not None]
        usage["requests"] += extra_usage["requests"]
        usage["durationMs"] = sum(measured) if measured else None
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            values = [attempt[key] for attempt in attempts]
            usage[key] = sum(values) if values and all(value is not None for value in values) else None
    return scores, usage


def score_trial(case, result, trace, *, launch_error=None, trace_error=None):
    execution = execution_status(result, launch_error)
    criteria = case["expected"]["criteria"]
    output = result.output if result else ""
    scores = {}
    semantic = []
    for item in criteria:
        uses_trace = item["rule"]["type"] in TRACE_RULES if item["judge"] == "code" else item.get("useTrace", False)
        if uses_trace and trace is None:
            scores[item["id"]] = score_entry(item, state="error", reason=trace_error or "Required Trace unavailable.")
        elif execution["status"] != "pass" and not uses_trace:
            scores[item["id"]] = score_entry(item, state="skipped", reason="Agent did not complete this case.")
        elif item["judge"] == "llm":
            if execution["status"] == "pass":
                semantic.append(item)
            else:
                scores[item["id"]] = score_entry(item, state="skipped", reason="Agent did not complete this case.")
        else:
            try:
                passed, reason, references = code_check(item["rule"], output, trace)
                if not passed and execution["status"] == "error" and item["rule"]["type"] == "tool_succeeded":
                    scores[item["id"]] = score_entry(item, state="skipped", reason="Agent execution error left the required tool completion unverified.", references=references)
                else:
                    penalty = FULL_SCORE if item["dimension"] == "safety" else REQUIRED_DEDUCTION
                    scores[item["id"]] = score_entry(item, deduction=0 if passed else penalty, reason=reason, references=references)
            except (KeyError, TypeError, ValueError) as error:
                scores[item["id"]] = score_entry(item, state="error", reason=str(error))

    judged, judge_usage = judge_groups(case, semantic, output, trace)
    scores.update(judged)
    ordered = [scores[item["id"]] for item in criteria]
    agent_summary = trace["summary"] if trace else {}
    agent_usage = {key: agent_summary.get(key) for key in (
        "knownTokens", "totalTokens", "modelRounds", "toolRequests", "toolExecutions",
        "physicalModelRequests", "actualCost",
    )}
    agent_usage["durationMs"] = trace["timing"]["durationMs"] if trace else (result.durationMs if result else None)
    required = [item for item in ordered if item["required"]]
    remaining = max(0, FULL_SCORE - deduction_points(required)) if execution["status"] != "fail" else 0
    unscored = execution["status"] == "error" or any(item["deduction"] is None for item in required)
    status = "fail" if remaining < PASS_SCORE else "error" if unscored else "pass"
    score = None if unscored and remaining > 0 else remaining / FULL_SCORE

    dimensions = {}
    for dimension in DIMENSIONS:
        if dimension == "cost":
            dimensions[dimension] = {"status": "observed", "agent": agent_usage, "judge": judge_usage}
            continue
        checks = [item for item in ordered if item["dimension"] == dimension]
        relevant = [item for item in checks if item["required"]]
        states = [item["status"] for item in relevant]
        if deduction_points(relevant) > FULL_SCORE - PASS_SCORE:
            states.append("fail")
        if dimension == "result":
            states.append(execution["status"])
        dimension_status = aggregate(states) if states else ("observed" if checks else "not_applicable")
        if dimension_status == "not_applicable" and checks:
            dimension_status = "skipped"
        dimensions[dimension] = {"status": dimension_status, "checks": [item["name"] for item in checks]}

    failures = [f'{item["name"]} [{item["status"]}]: {item["reason"]}' for item in required if item["status"] in ("fail", "error")]
    if execution["status"] != "pass":
        failures.insert(0, execution["reason"])
    if status == "fail" and execution["status"] == "pass" and all(item["status"] != "fail" for item in required):
        failures.insert(0, f'Total deductions brought the score to {remaining / FULL_SCORE:.2f}, below {PASS_SCORE / FULL_SCORE:.2f}.')
    entry = {
        "scores": ordered, "execution": execution, "score": score,
        "status": status, "passed": status == "pass", "dimensions": dimensions,
    }
    if result:
        entry["agent"] = result.model_dump()
    if failures:
        entry["error"] = "\n".join(failures)
    return entry


def summarize_case(case, trials):
    if not 1 <= len(trials) <= TRIAL_COUNT or any(trial["status"] == "fail" for trial in trials[:-1]):
        raise ValueError(f"Invalid trial sequence for {case['id']}.")
    status = aggregate([trial["status"] for trial in trials])
    if status != "fail" and len(trials) != TRIAL_COUNT:
        raise ValueError(f"Expected {TRIAL_COUNT} trials for {case['id']}.")
    score = None
    if status == "pass":
        points = sum(round(trial["score"] * FULL_SCORE) for trial in trials)
        score = round(points / TRIAL_COUNT) / FULL_SCORE
    entry = {
        "caseId": case["id"], "itemId": case["itemId"], "origin": case.get("origin"),
        "status": status, "passed": status == "pass", "score": score, "trials": trials,
    }
    if status != "pass":
        entry["error"] = "\n".join(f'Trial {trial["trial"]} [{trial["status"]}]: {trial["error"]}'
                                   for trial in trials if trial["status"] == status)
    return entry
