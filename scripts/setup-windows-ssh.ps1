param(
  [string]$PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIJGOmW3ldH6bs+Qlj68e9L7b+oiYHZCCeDbou3yfKGz codex-windows-migration"
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  throw "Abra o PowerShell como Administrador e rode de novo."
}

Write-Step "Instalando OpenSSH Server"
$capability = Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
if ($capability.State -ne "Installed") {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Host
} else {
  Write-Host "OpenSSH Server ja instalado."
}

Write-Step "Iniciando servico SSH"
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

Write-Step "Liberando firewall porta 22"
$rule = Get-NetFirewallRule -Name "sshd" -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -Name "sshd" -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Host
} else {
  Enable-NetFirewallRule -Name "sshd"
  Write-Host "Regra sshd ja existe."
}

Write-Step "Instalando chave publica"
$sshDir = Join-Path $env:ProgramData "ssh"
$adminKeys = Join-Path $sshDir "administrators_authorized_keys"
New-Item -ItemType Directory -Path $sshDir -Force | Out-Null

if (-not (Test-Path $adminKeys)) {
  New-Item -ItemType File -Path $adminKeys -Force | Out-Null
}

$content = Get-Content -LiteralPath $adminKeys -Raw -ErrorAction SilentlyContinue
if (-not $content -or -not $content.Contains($PublicKey)) {
  Add-Content -LiteralPath $adminKeys -Value $PublicKey
  Write-Host "Chave adicionada."
} else {
  Write-Host "Chave ja estava instalada."
}

Write-Step "Ajustando permissoes"
icacls $adminKeys /inheritance:r | Out-Host
icacls $adminKeys /grant "Administradores:F" /grant "SYSTEM:F" | Out-Host
icacls $adminKeys /grant "SISTEMA:F" 2>$null | Out-Null

Restart-Service sshd

Write-Step "Resumo"
Get-Service sshd | Format-Table -AutoSize
Write-Host ""
Write-Host "Hostname:"
hostname
Write-Host ""
Write-Host "ZeroTier IP:"
$ztCli = "C:\Program Files (x86)\ZeroTier\One\zerotier-cli.bat"
if (Test-Path $ztCli) {
  & $ztCli listnetworks | Select-String "3b19b3a716c84da5" | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "ZeroTier CLI nao encontrado."
}
Write-Host ""
Write-Host "SSH pronto."
