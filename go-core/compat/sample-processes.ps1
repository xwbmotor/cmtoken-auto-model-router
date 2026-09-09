param([string]$ProcessIds)
$ErrorActionPreference = 'Stop'
$sampleIds = @($ProcessIds.Split(',') | ForEach-Object { [int]$_ })
while ($true) {
  $sampleRows = @()
  foreach ($sampleId in $sampleIds) {
    $sampleProcess = Get-Process -Id $sampleId -ErrorAction SilentlyContinue
    if ($sampleProcess) {
      $sampleRows += @{ id = $sampleId; cpuMs = $sampleProcess.TotalProcessorTime.TotalMilliseconds; rssBytes = $sampleProcess.WorkingSet64 }
    }
  }
  @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = $sampleRows } | ConvertTo-Json -Depth 3 -Compress
  Start-Sleep -Milliseconds 200
}
