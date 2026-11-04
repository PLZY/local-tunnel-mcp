; Built by .github/workflows/release.yml after tools/pack.mjs win-x64.
#define AppVersion GetEnv("APP_VERSION")

[Setup]
AppId={{7E1D5B0A-3C44-4F7B-9A52-6D2B8E41C9F3}
AppName=Local Tunnel
AppVersion={#AppVersion}
AppPublisher=Local Tunnel MCP contributors
DefaultDirName={localappdata}\Programs\LocalTunnel
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
OutputDir=..\..\dist
OutputBaseFilename=LocalTunnel-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Local Tunnel
UninstallDisplayIcon={app}\icon.ico
SetupIconFile=..\icons\icon.ico

[Languages]
#if FileExists(CompilerPath + "Languages\ChineseSimplified.isl")
Name: "zh"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#elif FileExists(CompilerPath + "Languages\Unofficial\ChineseSimplified.isl")
Name: "zh"; MessagesFile: "compiler:Languages\Unofficial\ChineseSimplified.isl"
#else
Name: "en"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\dist\win-x64\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{userprograms}\Local Tunnel"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\tray.ps1"""; IconFilename: "{app}\icon.ico"; Flags: runminimized
Name: "{userdesktop}\Local Tunnel"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\tray.ps1"""; IconFilename: "{app}\icon.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\tray.ps1"""; Description: "{cm:LaunchProgram,Local Tunnel}"; Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\src\launcher.js"" stop"; Flags: runhidden; RunOnceId: "StopService"

[Code]
// A running service locks node.exe, so stop it before upgrading.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  if FileExists(ExpandConstant('{app}\runtime\node.exe')) then
    Exec(ExpandConstant('{app}\runtime\node.exe'), ExpandConstant('"{app}\src\launcher.js" stop'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
