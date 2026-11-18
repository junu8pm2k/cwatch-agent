import asyncio
import math
import os
from functools import lru_cache

from deepeval import assert_test
from deepeval.metrics import GEval
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase, LLMTestCaseParams
from openai import OpenAI, OpenAIError

from agent_adapter import CONFIG, ROOT


class BenchmarkJudge(DeepEvalBaseLLM):
    def load_model(self):
        api_key = os.getenv("JUDGE_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("missing JUDGE_API_KEY")
        config = CONFIG["judge"]
        return OpenAI(api_key=api_key, base_url=config["baseUrl"],
                      timeout=config["timeoutSeconds"], max_retries=0)

    def get_model_name(self):
        config = CONFIG["judge"]
        return f'{config["provider"]}/{config["model"]}'

    def generate(self, prompt, schema=None):
        config = CONFIG["judge"]
        try:
            result = self.model.chat.completions.create(
                model=config["model"], temperature=config["temperature"],
                max_tokens=config["maxTokens"],
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
            )
        except OpenAIError as error:
            status = getattr(error, "status_code", None)
            raise RuntimeError(f"Judge API request failed ({status or type(error).__name__})") from None
        choice = result.choices[0]
        if choice.finish_reason != "stop" or not choice.message.content:
            raise RuntimeError("Judge returned no complete JSON response")
        return schema.model_validate_json(choice.message.content) if schema else choice.message.content

    async def a_generate(self, prompt, schema=None):
        return await asyncio.to_thread(self.generate, prompt, schema)


@lru_cache(maxsize=1)
def judge():
    return BenchmarkJudge()


def tool_score(case, result):
    expected = case["expected"]
    matching = [
        tool for tool in result.tools
        if tool.name == expected["tool"] and tool.status == "completed"
        and not tool.hadError and tool.arguments is not None
        and all(tool.arguments.get(key) == value for key, value in expected["arguments"].items())
    ]
    return (1.0, "Expected tool and arguments executed successfully") if matching else (
        0.0, f'No successful {expected["tool"]} call had the expected arguments',
    )


def score(name, case, result):
    definition = CONFIG["metrics"][name]
    threshold = definition["threshold"]
    if name == "tool_correctness":
        value, reason = tool_score(case, result)
    else:
        rubric = (ROOT / "evals/rubrics" / definition["rubric"]).read_text(encoding="utf-8").strip()
        metric = GEval(
            name=name, evaluation_steps=[rubric], threshold=threshold, model=judge(), async_mode=False,
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.EXPECTED_OUTPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
        )
        test_case = LLMTestCase(
            name=case["id"], input=case["input"], expected_output=case["expected"]["answer"], actual_output=result.output,
        )
        try:
            assert_test(test_case, [metric], run_async=False)
        except AssertionError:
            if metric.error or metric.score is None or metric.score >= threshold:
                raise
        value, reason = metric.score, metric.reason
    if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1 or not reason:
        raise RuntimeError("missing or invalid score for " + name)
    return {"name": name, "value": value, "reason": reason, "threshold": threshold, "passed": value >= threshold}
