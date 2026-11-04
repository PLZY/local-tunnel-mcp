# Builds dist/LocalTunnel-<version>.exe after tools/pack.mjs win-x64.
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference='Stop'

$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stage=Join-Path $root 'dist\win-x64'
$zip=Join-Path $stage 'app.zip'
$versionFile=Join-Path $stage 'version.txt'
$output=Join-Path $root "dist\LocalTunnel-$Version.exe"

if(Test-Path $zip){Remove-Item $zip}
[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $stage 'app'),$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
[IO.File]::WriteAllText($versionFile,$Version)

$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$output" `
  "/win32icon:$(Join-Path $root 'packaging\icons\icon.ico')" `
  "/resource:$zip,app.zip" "/resource:$versionFile,version" `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
  (Join-Path $PSScriptRoot 'LocalTunnel.cs')
if($LASTEXITCODE -ne 0){throw "csc failed with exit code $LASTEXITCODE"}
