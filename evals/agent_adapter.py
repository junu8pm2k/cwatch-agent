import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
NODE_AGENT = ("node", "--use-env-proxy", "--experimental-transform-types", "evals/benchmark-agent.ts")
CONFIG = json.loads((ROOT / "evals/config.json").read_text(encoding="utf-8"))


class ToolCall(BaseModel):
    name: str
    arguments: dict | None
    status: str
    hadError: bool


class AgentResult(BaseModel):
    runId: str = Field(pattern=r"^[0-9a-zA-Z_-]{1,80}$")
    status: str
    output: str
    tools: list[ToolCall]
    durationMs: int = Field(ge=0)
    error: str | None


def agent_command(command, *args, payload=None, timeout=30):
    inherited = {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
        "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
        "NODE_EXTRA_CA_CERTS",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in inherited}
    if command == "run":
        api_key = os.getenv("BENCHMARK_AGENT_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("missing Agent API_KEY")
        env["API_KEY"] = api_key
        env["HOME"] = payload["workDir"]
        env["USERPROFILE"] = payload["workDir"]
    try:
        result = subprocess.run(
            (*NODE_AGENT, command, *args), input=json.dumps(payload) if payload is not None else "",
            capture_output=True, encoding="utf-8", cwd=ROOT, env=env, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"TypeScript Agent {command} timed out after {timeout}s") from None
    if result.returncode:
        raise RuntimeError(f"TypeScript Agent {command} exited {result.returncode}: {result.stderr.strip()[-1500:]}")
    return result.stdout


def load_manifest(suite):
    return json.loads(agent_command("manifest", suite))


def run_agent(case, case_dir):
    workspace_cache = ROOT / ".cache"
    workspace_cache.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="bench-", dir=workspace_cache) as temp_dir:
        profile = {"profile": case["profile"]} if "profile" in case else {}
        result = agent_command(
            "run", timeout=CONFIG["limits"]["timeoutMs"] // 1000 + 20,
            payload={
                "id": case["id"], "input": case["input"], "fixture": case["fixture"],
                "workDir": temp_dir, "traceFile": str(case_dir / "trace.json"), **profile,
            },
        )
        return AgentResult.model_validate_json(result)
