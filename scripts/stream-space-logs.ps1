# Stream Hugging Face Space run logs (SSE).
# Usage:
#   $env:HF_TOKEN = "hf_xxx"; .\scripts\stream-space-logs.ps1
#   .\scripts\stream-space-logs.ps1 -Token "hf_xxx"
# Space: https://huggingface.co/spaces/zimejin/deeptrust

param(
    [string] $Token = $env:HF_TOKEN,
    [string] $Space = "zimejin/deeptrust"
)

if (-not $Token) {
    Write-Error "Set HF_TOKEN or pass -Token."
    exit 1
}

$url = "https://huggingface.co/api/spaces/$Space/logs/run"
Write-Host "Streaming logs from $url (Ctrl+C to stop)"
curl.exe -N -H "Authorization: Bearer $Token" $url
