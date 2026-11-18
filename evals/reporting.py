import hashlib
import json
import os
import platform
from contextlib import contextmanager
from datetime import datetime, timezone
from importlib.metadata import version
from uuid import uuid4

from agent_adapter import CONFIG, ROOT


def now():
    return datetime.now(timezone.utc).isoformat()


class BenchmarkReport:
    def __init__(self, directory, manifest, suite, cases):
        self.directory = directory
        self.cases = {}
        self.metadata = {
            "runId": os.environ["BENCHMARK_RUN_ID"],
            "commitSha": os.environ["BENCHMARK_COMMIT"],
            "treeState": os.environ["BENCHMARK_TREE_STATE"],
            "dataset": manifest["dataset"], "suite": suite, "suiteHashes": manifest["suites"],
            "agent": CONFIG["agent"], "judge": CONFIG["judge"], "metrics": CONFIG["metrics"],
            "limits": CONFIG["limits"], "fixtureHashes": manifest["fixtureHashes"],
            "skillHashes": manifest["skillHashes"],
            "rubricHashes": {
                rule["rubric"]: hashlib.sha256((ROOT / "evals/rubrics" / rule["rubric"]).read_bytes()).hexdigest()
                for rule in CONFIG["metrics"].values() if "rubric" in rule
            },
            "environment": {
                "kind": os.environ["BENCHMARK_ENV"], "platform": platform.platform(),
                "python": platform.python_version(), "node": manifest["nodeVersion"], "deepEval": version("deepeval"),
            },
            "startedAt": now(), "expectedCaseIds": [case["id"] for case in cases],
        }
        self.write()

    def case_dir(self, case_id):
        path = self.directory / "cases" / case_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    @contextmanager
    def record(self, case):
        entry = {
            "caseId": case["id"], "itemId": case["itemId"], "scores": [],
            "passed": False, "origin": case.get("origin"),
        }
        try:
            yield entry
            entry["passed"] = True
        except Exception as error:
            entry["error"] = str(error)
            raise
        finally:
            self.cases[case["id"]] = entry
            self.write()

    def write(self):
        count = len(self.metadata["expectedCaseIds"])
        passed = sum(entry["passed"] for entry in self.cases.values())
        summary = {"expected": count, "executed": len(self.cases), "passed": passed,
                   "failed": len(self.cases) - passed, "complete": len(self.cases) == count}
        destination = self.directory / "report.json"
        temporary = destination.with_suffix(f".{uuid4()}.tmp")
        temporary.write_text(
            json.dumps({**self.metadata, "updatedAt": now(), "summary": summary, "cases": list(self.cases.values())},
                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        temporary.replace(destination)
