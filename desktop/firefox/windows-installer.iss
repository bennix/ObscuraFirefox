#define AppVersion "0.3.7"
[Setup]
AppId=ai.obscura.firefox
AppName=Obscura Firefox
AppVersion={#AppVersion}
AppPublisher=Obscura Firefox contributors
AppPublisherURL=https://github.com/bennix/ObscuraFirefox
DefaultDirName={localappdata}\Programs\Obscura Firefox
DefaultGroupName=Obscura Firefox
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=ObscuraFirefox-{#AppVersion}-windows-x64-setup
SetupIconFile=branding\generated\firefox.ico
UninstallDisplayIcon={app}\Obscura.exe
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
[Files]
Source: "..\dist\portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Obscura Firefox"; Filename: "{app}\Obscura.exe"
Name: "{autodesktop}\Obscura Firefox"; Filename: "{app}\Obscura.exe"; Tasks: desktopicon
[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
[Run]
Filename: "{app}\Obscura.exe"; Description: "Launch Obscura Firefox"; Flags: nowait postinstall skipifsilent
