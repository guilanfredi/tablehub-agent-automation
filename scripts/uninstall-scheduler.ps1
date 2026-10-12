<#
.SYNOPSIS
  Para e remove o despachante do Agendador de Tarefas (e a tarefa antiga "TableHub Agentes", se existir).
  Execuções em andamento continuam até terminar; no próximo início, o despachante volta a acompanhá-las.
#>
param([switch]$Quiet)
foreach ($name in 'Agentes do Claude Code', 'TableHub Agentes') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}

# o Agendador encerra o PowerShell, mas o node pode sobreviver: encerra pelo PID registrado
$daemonFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'state\daemon.json'
if (Test-Path $daemonFile) {
  $daemon = Get-Content $daemonFile -Raw | ConvertFrom-Json
  $proc = Get-Process -Id $daemon.pid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $daemon.pid -Force }
  Remove-Item $daemonFile -Force -ErrorAction SilentlyContinue
}
if (-not $Quiet) { Write-Host 'Despachante parado e removido do Agendador.' }
