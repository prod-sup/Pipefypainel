<#
  deploy.ps1 — publica o Painel Pipefy no Firebase (Hosting + Cloud Function).
  Rode de dentro da pasta Pipefypainel:  .\deploy.ps1

  Pré-requisitos (uma vez na vida da máquina):
    - Node 20 e npm
    - npm i -g firebase-tools
    - firebase login
    - projeto design-1-53c00 no plano Blaze (Functions exige)
#>

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== Painel Pipefy -> Firebase (design-1-53c00) ==" -ForegroundColor Cyan

# 0) firebase-tools instalado?
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  Write-Host "firebase-tools nao encontrado. Instale com: npm i -g firebase-tools" -ForegroundColor Red
  exit 1
}

# 1) dependencias da function
Write-Host "`n[1/4] Instalando dependencias da function..." -ForegroundColor Yellow
npm --prefix functions install

# 2) .env (PIPEFY_PIPE_ID) — nao e segredo
if (-not (Test-Path "functions/.env")) {
  Write-Host "`n[2/4] Criando functions/.env a partir do exemplo..." -ForegroundColor Yellow
  Copy-Item "functions/.env.example" "functions/.env"
  Write-Host "    -> confira o PIPEFY_PIPE_ID em functions/.env (padrao 304354423)"
} else {
  Write-Host "`n[2/4] functions/.env ja existe — mantido." -ForegroundColor Yellow
}

# 3) token secreto (so pede se ainda nao existir no Secret Manager)
Write-Host "`n[3/4] Verificando o segredo PIPEFY_TOKEN..." -ForegroundColor Yellow
$hasSecret = $false
try {
  firebase functions:secrets:access PIPEFY_TOKEN --project design-1-53c00 *> $null
  if ($?) { $hasSecret = $true }
} catch { $hasSecret = $false }

if ($hasSecret) {
  Write-Host "    -> PIPEFY_TOKEN ja configurado."
} else {
  Write-Host "    -> PIPEFY_TOKEN nao existe. Cole o token do Pipefy quando pedir:"
  firebase functions:secrets:set PIPEFY_TOKEN --project design-1-53c00
}

# 4) deploy
Write-Host "`n[4/4] Publicando hosting + functions..." -ForegroundColor Yellow
firebase deploy --only hosting,functions --project design-1-53c00

Write-Host "`nPronto! Painel no ar em: https://design-1-53c00.web.app/" -ForegroundColor Green
Write-Host "O card 'Criacao de Eventos' da hub ja aponta pra la." -ForegroundColor Green
