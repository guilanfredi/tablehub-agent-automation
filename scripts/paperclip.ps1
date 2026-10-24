<#
.SYNOPSIS
  Inicia o Paperclip (orquestrador dos agentes) com o ambiente que ele precisa no Windows.

.DESCRIPTION
  - Põe o Git Bash no PATH só deste processo: o Paperclip usa `sh` para criar os worktrees isolados e rodar
    o `npm ci` de cada issue, e o Windows não tem `sh` no PATH.
  - Fixa a versão do Paperclip (as versões novas às vezes trazem mudanças incompatíveis); para atualizar,
    troque $Version depois de ler as notas da versão.
  - Desliga a telemetria anônima também pela variável de ambiente.
  - Mantém o origin/main dos projetos em dia (git fetch a cada 5 min): o Paperclip cria o worktree de cada issue a
    partir do origin/main da cópia principal e não faz fetch sozinho.
  No Windows o Paperclip não roda como serviço: ele funciona enquanto esta janela estiver aberta.
#>
$Version = '2026.1012.0'
$Repos = @('D:\dev\TableHub')

$gitBin = 'C:\Program Files\Git\bin'
if (-not (Test-Path (Join-Path $gitBin 'sh.exe'))) { throw "Não achei $gitBin\sh.exe (Git for Windows)." }
$env:Path = "$gitBin;$env:Path"
$env:PAPERCLIP_TELEMETRY_DISABLED = '1'

# fetch periódico em segundo plano; termina junto com esta janela
$fetchJob = Start-Job -ArgumentList (, $Repos) -ScriptBlock {
  param($repos)
  while ($true) {
    foreach ($r in $repos) { git -C $r fetch -q origin 2>$null }
    Start-Sleep -Seconds 300
  }
}

Write-Host "Paperclip $Version em http://127.0.0.1:3100 (Ctrl+C para parar)"
try {
  npx --yes "paperclipai@$Version" run
} finally {
  Stop-Job $fetchJob -ErrorAction SilentlyContinue
  Remove-Job $fetchJob -Force -ErrorAction SilentlyContinue
}
