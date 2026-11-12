param([string]$LangfuseDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\langfuse'), [switch]$Stop)
$ErrorActionPreference = 'Stop'
$experimentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$experimentState = Join-Path $experimentRoot '.runtime\langfuse-experiments'
$experimentServiceFile = Join-Path $experimentState 'service.json'
$experimentNode = (Get-Command node).Source
if (Test-Path -LiteralPath $experimentServiceFile) {
    $experimentService = Get-Content -LiteralPath $experimentServiceFile -Raw | ConvertFrom-Json
    $experimentProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$experimentService.pid) -ErrorAction SilentlyContinue
    if ($experimentProcess -and $experimentProcess.CommandLine -like '*scripts/langfuse-experiments.ts*') { Stop-Process -Id $experimentService.pid }
}
if ($Stop) { docker stop cwatch-langfuse-hook; exit $LASTEXITCODE }
New-Item -ItemType Directory -Force -Path (Join-Path $experimentState 'inbox') | Out-Null
$experimentProcess = Start-Process -FilePath $experimentNode -ArgumentList @('--use-env-proxy','--experimental-transform-types','scripts/langfuse-experiments.ts','--port','4311') -WorkingDirectory $experimentRoot -RedirectStandardOutput (Join-Path $experimentState 'server.log') -RedirectStandardError (Join-Path $experimentState 'server.err.log') -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($experimentProcess.HasExited) { throw 'Experiment executor exited; inspect .runtime/langfuse-experiments/server.err.log' }
    try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:4311/health' -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 400 }
}
$experimentTokenFile = Join-Path $experimentState 'webhook-token'
if (-not (Test-Path -LiteralPath $experimentTokenFile)) { throw 'Executor token not initialized' }
$experimentCompose = Join-Path (Resolve-Path $LangfuseDirectory).Path 'docker-compose.yml'
$experimentOverride = Join-Path $experimentRoot 'ops\langfuse-webhook.override.yaml'
docker compose --project-directory $LangfuseDirectory -f $experimentCompose -f $experimentOverride up -d --no-deps langfuse-web
if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the exact Docker webhook host' }
$experimentNetwork = docker inspect langfuse-langfuse-web-1 --format '{{range $name, $v := .NetworkSettings.Networks}}{{$name}}{{end}}'
$experimentImage = docker inspect langfuse-langfuse-web-1 --format '{{.Config.Image}}'
$existingReceiver = docker ps -a --filter 'name=^/cwatch-langfuse-hook$' --format '{{.Names}}'
if ($existingReceiver) {
    $receiverLabels = docker inspect cwatch-langfuse-hook --format '{{json .Config.Labels}}' | ConvertFrom-Json
    $receiverOwner = $receiverLabels.'cwatch.role'
    if ($receiverOwner -ne 'langfuse-hook') { throw 'Existing receiver is not owned by this integration' }
    docker restart cwatch-langfuse-hook
} else {
    docker run -d --name cwatch-langfuse-hook --restart unless-stopped --label cwatch.role=langfuse-hook --network $experimentNetwork --entrypoint node --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 256m --pids-limit 64 --mount ('type=bind,source=' + (Join-Path $experimentRoot 'ops\langfuse-hook-receiver.mjs') + ',target=/receiver.mjs,readonly') --mount ('type=bind,source=' + $experimentTokenFile + ',target=/run/cwatch-token,readonly') --mount ('type=bind,source=' + (Join-Path $experimentState 'inbox') + ',target=/queue') $experimentImage /receiver.mjs
}
if ($LASTEXITCODE -ne 0) { throw 'Unable to start the Docker-only webhook receiver' }
Write-Output 'Langfuse experiment integration ready. Local executor: http://127.0.0.1:4311/jobs'
Write-Output 'Dataset webhook URL: http://cwatch-langfuse-hook/langfuse/experiments'
