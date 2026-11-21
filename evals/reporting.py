import hashlib
import json
import os
import platform
from datetime import datetime, timezone
from importlib.metadata import version
from uuid import uuid4

from agent_adapter import CONFIG, ROOT
from evaluation import TRIAL_COUNT
from metrics import FULL_SCORE, JUDGE_RUBRIC, MINOR_DEDUCTION, PASS_SCORE, REQUIRED_DEDUCTION


def now():
    return datetime.now(timezone.utc).isoformat()


class BenchmarkReport:
    def __init__(self, directory, manifest, suite, cases):
        self.directory = directory
        self.cases = {}
        self.metadata = {
            "schemaVersion": 4,
            "runId": os.environ["BENCHMARK_RUN_ID"],
            "commitSha": os.environ["BENCHMARK_COMMIT"],
            "treeState": os.environ["BENCHMARK_TREE_STATE"],
            "dataset": manifest["dataset"], "suite": suite, "suiteHashes": manifest["suites"],
            "agent": CONFIG["agent"], "judge": CONFIG["judge"],
            "scoring": {"trialsPerCase": TRIAL_COUNT, "max": 1, "threshold": PASS_SCORE / FULL_SCORE,
                        "requiredDeduction": REQUIRED_DEDUCTION / FULL_SCORE, "minorDeduction": MINOR_DEDUCTION / FULL_SCORE},
            "limits": CONFIG["limits"], "fixtureHashes": manifest["fixtureHashes"],
            "skillHashes": manifest["skillHashes"],
            "rubricHashes": {"judge.md": hashlib.sha256(JUDGE_RUBRIC.encode("utf-8")).hexdigest()},
            "scorerHashes": {path: hashlib.sha256((ROOT / "evals" / path).read_bytes()).hexdigest()
                             for path in ("metrics.py", "evaluation.py")},
            "environment": {
                "kind": os.environ["BENCHMARK_ENV"], "platform": platform.platform(),
                "python": platform.python_version(), "node": manifest["nodeVersion"], "pytest": version("pytest"),
            },
            "startedAt": now(), "expectedCaseIds": [case["id"] for case in cases],
        }
        self.write()

    def trial_dir(self, case_id, trial):
        path = self.directory / "cases" / case_id / f"trial-{trial}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def record(self, entry):
        self.cases[entry["caseId"]] = entry
        self.write()

    def write(self):
        count = len(self.metadata["expectedCaseIds"])
        summary = {"expected": count, "executed": len(self.cases), "complete": len(self.cases) == count}
        for key, status in (("passed", "pass"), ("failed", "fail"), ("errors", "error")):
            summary[key] = sum(entry["status"] == status for entry in self.cases.values())
        destination = self.directory / "report.json"
        temporary = destination.with_suffix(f".{uuid4()}.tmp")
        temporary.write_text(
            json.dumps({**self.metadata, "updatedAt": now(), "summary": summary, "cases": list(self.cases.values())},
                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        temporary.replace(destination)
