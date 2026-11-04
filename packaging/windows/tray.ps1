# Starts the service and stays in the notification area until the user quits.
Add-Type -AssemblyName System.Windows.Forms,System.Drawing

$node=Join-Path $PSScriptRoot 'runtime\node.exe'
$launcher=Join-Path $PSScriptRoot 'src\launcher.js'

function Invoke-Launcher([string]$action) {
  $output=& $node $launcher $action 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){
    [Windows.Forms.MessageBox]::Show($output.Trim(),'Local Tunnel','OK','Error') | Out-Null
  }
}

# A second launch only opens the console of the running instance.
$mutex=New-Object Threading.Mutex($false,'Local\LocalTunnelTray')
if(-not $mutex.WaitOne(0)){
  Invoke-Launcher 'start'
  exit
}

Invoke-Launcher 'start'

$menu=New-Object Windows.Forms.ContextMenuStrip
$open=$menu.Items.Add('打开控制台')
$quit=$menu.Items.Add('退出')

$tray=New-Object Windows.Forms.NotifyIcon
$image=[Drawing.Image]::FromFile((Join-Path $PSScriptRoot 'public\icon.png'))
$tray.Icon=[Drawing.Icon]::FromHandle((New-Object Drawing.Bitmap($image,32,32)).GetHicon())
$tray.Text='Local Tunnel'
$tray.ContextMenuStrip=$menu
$tray.Visible=$true

$open.add_Click({Invoke-Launcher 'start'})
$tray.add_DoubleClick({Invoke-Launcher 'start'})
$quit.add_Click({
  Invoke-Launcher 'stop'
  $tray.Visible=$false
  [Windows.Forms.Application]::Exit()
})

[Windows.Forms.Application]::Run()
$tray.Dispose()
$mutex.ReleaseMutex()
