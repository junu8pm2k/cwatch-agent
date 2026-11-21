import json
import math
import os
from functools import lru_cache
from time import perf_counter

from openai import OpenAI, OpenAIError
from pydantic import BaseModel, ConfigDict

from agent_adapter import CONFIG, ROOT


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    checks: dict[str, str]
    references: list[str]
    reason: str


JUDGE_RUBRIC = (ROOT / "evals/rubrics/judge.md").read_text(encoding="utf-8")
TRACE_RULES = {"tool_succeeded", "tool_policy", "tool_dependency"}
TOOL_EVENT_TYPES = {"request": "pre_tool_use_request", "execution": "execution_started"}
CHECK_OUTCOMES = {"must": ("met", "missing"), "fatal": ("clear", "triggered"), "minor": ("clear", "triggered")}
FULL_SCORE = 100
PASS_SCORE = CONFIG["scoring"]["passPoints"]
REQUIRED_DEDUCTION = CONFIG["scoring"]["requiredDeductionPoints"]
MINOR_DEDUCTION = CONFIG["scoring"]["minorDeductionPoints"]


@lru_cache(maxsize=1)
def judge_client():
    config = CONFIG["judge"]
    api_key = os.getenv("JUDGE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("missing JUDGE_API_KEY")
    return OpenAI(api_key=api_key, base_url=config["baseUrl"], timeout=config["timeoutSeconds"], max_retries=0)


def score_entry(criterion, *, deduction=None, reason, references=(), state=None):
    points = FULL_SCORE - deduction if deduction is not None else None
    return {
        "name": criterion["id"], "dimension": criterion["dimension"], "judge": criterion["judge"],
        "required": criterion["required"], "value": points / FULL_SCORE if points is not None else None,
        "deduction": deduction / FULL_SCORE if deduction is not None else None,
        "max": 1, "threshold": PASS_SCORE / FULL_SCORE,
        "status": state or ("pass" if points >= PASS_SCORE else "fail"),
        "reason": reason, "references": list(references),
    }


def unique_object(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError("duplicate JSON keys")
    return value


def reject_constant(value):
    raise ValueError(f"invalid JSON constant {value}")


def json_equal(actual, expected):
    # Python treats booleans as integers. The rubric applies JSON value equality.
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return (not isinstance(actual, float) or math.isfinite(actual)) and actual == expected
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(json_equal(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(json_equal(a, b) for a, b in zip(actual, expected))
    return actual == expected


def tool_matches(step, target):
    arguments = step["input"]
    return step["name"] == target["name"] and all(
        isinstance(arguments, dict) and key in arguments and json_equal(arguments[key], value)
        for key, value in target.get("arguments", {}).items()
    )


def tool_success(step):
    return (step["status"] == "completed" and step["error"] is None
            and step["resultStatus"] in (None, "ok", "success", "completed", "success_with_data", "success_empty"))


def refs_for(rows):
    return [f'trace:{event["eventId"]}' for event, _ in rows]


def code_check(rule, output, trace):
    kind = rule["type"]
    if kind == "json_equals":
        try:
            actual = json.loads(output, object_pairs_hook=unique_object, parse_constant=reject_constant)
        except (RecursionError, ValueError):
            return False, "回答必须是一个有效且键唯一的 JSON 对象。", ["answer"]
        return json_equal(actual, rule["value"]), "比较了完整 JSON 对象与预期字段和值。", ["answer"]
    if kind == "max_characters":
        count = sum(not char.isspace() for char in output)
        return count <= rule["limit"], f'回答含 {count} 个非空白字符，上限为 {rule["limit"]}。', ["answer"]

    if trace is None:
        raise ValueError("此规则需要经过校验的完整 Trace。")
    steps = {step["stepId"]: step for step in trace["steps"] if step["kind"] == "tool"}
    events = [(event, steps[event["stepId"]]) for event in trace["events"] if event["stepId"] in steps]

    if kind == "tool_succeeded":
        requests = [(event, step) for event, step in events
                    if event["type"] == TOOL_EVENT_TYPES["request"] and tool_matches(step, rule["tool"])]
        completions = [(event, step) for event, step in events
                       if event["type"] == "execution_finished" and tool_matches(step, rule["tool"]) and tool_success(step)]
        successful = {step["stepId"] for _, step in completions}
        failed_requests = [(event, step) for event, step in requests if step["stepId"] not in successful]
        if not rule.get("allowFailedAttempts", True) and failed_requests:
            return False, "检测到指定工具的未成功请求。", refs_for(failed_requests)
        if completions:
            return True, "指定工具和参数成功执行。", refs_for(completions)
        return False, "完整 Trace 中没有符合条件的成功执行。", refs_for(requests) or ["trace"]

    if kind == "tool_policy":
        selected = [(event, step) for event, step in events if event["type"] == TOOL_EVENT_TYPES[rule["stage"]]]
        is_deny = rule["policy"] == "deny"
        violations = [(event, step) for event, step in selected
                      if any(tool_matches(step, target) for target in rule["tools"]) == is_deny]
        stage = "请求" if rule["stage"] == "request" else "执行"
        if violations:
            return False, f"发现 {len(violations)} 次违反策略的工具{stage}。", refs_for(violations)
        return True, f"已检查 {len(selected)} 次工具{stage}，均符合策略。", ["trace"]

    if kind == "tool_dependency":
        before = [(event, step) for event, step in events if event["type"] == "execution_finished"
                  and tool_matches(step, rule["before"]) and tool_success(step)]
        after = [(event, step) for event, step in events if event["type"] == TOOL_EVENT_TYPES[rule["afterStage"]]
                 and tool_matches(step, rule["after"])]
        cutoff = min((event["sequence"] for event, _ in before), default=None)
        early = [(event, step) for event, step in after if cutoff is None or event["sequence"] <= cutoff]
        if early:
            return False, "依赖动作发生时，前置动作尚未成功。", refs_for(early)
        return True, "已发生的依赖动作均满足前置条件。", refs_for(before + after) or ["trace"]

    raise ValueError(f"unsupported code rule: {kind}")


def semantic_input(case, criteria, output, trace):
    answer = {f"answer:L{index}": line for index, line in enumerate(output.splitlines(), 1)}
    material = {f"material:L{index}": line for index, line in enumerate(case["material"].splitlines(), 1)}
    references = {"answer", *answer, *material}
    payload = {"task": case["input"], "fixture": case["fixture"], "answer": answer, "material": material, "criteria": criteria}
    if any(item.get("useTrace") for item in criteria):
        tool_steps = {step["stepId"]: step for step in trace["steps"] if step["kind"] == "tool"}
        events = {
            f'trace:{event["eventId"]}': {"type": event["type"], "tool": tool_steps[event["stepId"]]["name"],
                                         "status": event["status"]}
            for event in trace["events"] if event["stepId"] in tool_steps
            and event["type"] in {"pre_tool_use_request", "execution_started", "execution_finished", "approval_resolved"}
        }
        payload["trace"] = events
        references.update({"trace", *events})
    return payload, references


def checks_for(criterion):
    return [(f"{field}-{index}", field, index, text) for field in CHECK_OUTCOMES
            for index, text in enumerate(criterion.get(field, []), 1)]


def finding_schema(criterion):
    schema = Finding.model_json_schema()
    properties = {key: {"type": "string", "enum": list(CHECK_OUTCOMES[field]), "description": text}
                  for key, field, _, text in checks_for(criterion)}
    schema["properties"]["checks"] = {"type": "object", "properties": properties, "required": list(properties),
                                       "additionalProperties": False}
    return schema


def score_finding(criterion, finding, references):
    checks = checks_for(criterion)
    if set(finding.checks) != {key for key, _, _, _ in checks}:
        raise ValueError("Judge omitted or added a rubric check")
    detected = {"fatal": [], "missing": [], "minor": []}
    for key, field, index, _ in checks:
        acceptable, defect = CHECK_OUTCOMES[field]
        outcome = finding.checks[key]
        if outcome == defect:
            detected["missing" if field == "must" else field].append(index)
        elif outcome != acceptable:
            raise ValueError(f"Judge returned an invalid outcome for {key}")
    allowed = references if criterion.get("useTrace") else {ref for ref in references if not ref.startswith("trace")}
    if not finding.reason.strip() or not finding.references or not set(finding.references) <= allowed:
        raise ValueError("Judge returned missing or invalid references")
    deduction = FULL_SCORE if detected["fatal"] else min(
        FULL_SCORE, REQUIRED_DEDUCTION * len(detected["missing"]) + MINOR_DEDUCTION * len(detected["minor"]),
    )
    return score_entry(criterion, deduction=deduction, reason=finding.reason.strip()[:2000], references=finding.references) | {
        "findings": detected,
    }


def semantic_scores(case, criteria, output, trace):
    usage = {"requests": 0, "inputTokens": None, "outputTokens": None, "totalTokens": None, "durationMs": None, "actualCost": None}
    if not criteria:
        return {}, usage
    started = perf_counter()
    try:
        payload, references = semantic_input(case, criteria, output, trace)
        config = CONFIG["judge"]
        client = judge_client()
        ids = [item["id"] for item in criteria]
        schema = {"type": "object", "properties": {item["id"]: finding_schema(item) for item in criteria},
                  "required": ids, "additionalProperties": False}
        usage["requests"] = 1
        response = client.chat.completions.create(
            model=config["model"], temperature=config["temperature"], max_tokens=config["maxTokens"],
            messages=[{"role": "system", "content": JUDGE_RUBRIC},
                      {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            response_format={"type": "json_schema", "json_schema": {
                "name": "Assessment", "schema": schema, "strict": True}},
        )
        if response.usage:
            usage.update(inputTokens=response.usage.prompt_tokens, outputTokens=response.usage.completion_tokens,
                         totalTokens=response.usage.total_tokens)
        if not response.choices or response.choices[0].finish_reason != "stop" or not response.choices[0].message.content:
            raise RuntimeError("Judge did not return a completed assessment")
        assessment = json.loads(response.choices[0].message.content, object_pairs_hook=unique_object, parse_constant=reject_constant)
        if not isinstance(assessment, dict) or assessment.keys() - set(ids):
            raise RuntimeError("Judge returned an invalid criterion map")
        scores = {}
        for criterion in criteria:
            try:
                if criterion["id"] not in assessment:
                    raise ValueError("Judge omitted the criterion")
                finding = Finding.model_validate(assessment[criterion["id"]])
                scores[criterion["id"]] = score_finding(criterion, finding, references)
            except ValueError as error:
                scores[criterion["id"]] = score_entry(criterion, state="error", reason=str(error))
        return scores, usage
    except OpenAIError as error:
        reason = f'Judge API request failed ({getattr(error, "status_code", None) or type(error).__name__})'
    except RuntimeError as error:
        reason = str(error)
    except (RecursionError, ValueError):
        reason = "Judge returned an invalid assessment"
    finally:
        usage["durationMs"] = round((perf_counter() - started) * 1000)
    return {item["id"]: score_entry(item, state="error", reason=reason) for item in criteria}, usage
