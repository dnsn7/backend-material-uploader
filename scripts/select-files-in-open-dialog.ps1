param(
  [Parameter(Mandatory = $true)]
  [string]$FolderPath,

  [int]$InitialDelayMs = 1200,
  [int]$AfterOpenDelayMs = 1200
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

if (-not (Test-Path -LiteralPath $FolderPath)) {
  throw "目录不存在: $FolderPath"
}

Start-Sleep -Milliseconds $InitialDelayMs

$activated = $false
foreach ($title in @('打开', 'Open')) {
  try {
    if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
      $activated = $true
      break
    }
  } catch {
  }
}

if (-not $activated) {
  throw '未找到文件打开对话框'
}

Set-Clipboard -Value $FolderPath
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("%d")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds $AfterOpenDelayMs
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
