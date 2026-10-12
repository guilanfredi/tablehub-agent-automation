<#
.SYNOPSIS
  Registra o despachante no Agendador de Tarefas do Windows: inicia no logon, fica rodando e é
  reiniciado se cair. Remove a tarefa antiga "TableHub Agentes" (despachante que ficava no TableHub).
  Para remover: scripts\uninstall-scheduler.ps1 (ou npm run agendador:remover)
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'Agentes do Claude Code'
$appDir = Split-Path $PSScriptRoot -Parent
$script = Join-Path $appDir 'src\dispatcher\index.mjs'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path (Join-Path $appDir 'config.local.json'))) {
  throw 'Falta config.local.json: copie config.example.json e ajuste os caminhos dos projetos.'
}

# para a versão anterior (desta automação ou a antiga, de dentro do TableHub) antes de registrar
& (Join-Path $PSScriptRoot 'uninstall-scheduler.ps1') -Quiet

# janela oculta: o node herda o console escondido do PowerShell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $appDir `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"& '$node' '$script'; exit `$LASTEXITCODE`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Despachante contínuo dos agentes do Claude Code (tablehub-agent-automation).' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Tarefa '$TaskName' registrada e iniciada: roda continuamente enquanto você estiver logado."
Write-Host "Log: $(Join-Path $appDir 'logs\dispatcher.log')"
