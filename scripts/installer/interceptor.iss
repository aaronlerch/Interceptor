; Inno Setup script for the Interceptor Windows browser surface.
;
; Per-user install. No admin / UAC by default — Chromium scopes native
; messaging hosts per-user (HKCU), so a per-machine install would gain
; nothing. PrivilegesRequiredOverridesAllowed=dialog still lets a power
; user opt into a per-machine install at the elevation prompt.
;
; In-place upgrade: the AppId GUID is stable across versions. Running
; this installer when a previous version is present silently removes
; the old install (including any locked interceptor-daemon.exe via
; Restart Manager) before laying down the new files.
;
; Compile from the repo root with:
;   ISCC.exe /DAppVersion=0.14.2 scripts\installer\interceptor.iss

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

#define AppId "{B7F4D8A1-3E22-4B91-A6E4-9C2D5F8A1234}"

[Setup]
AppId={{#AppId}}
AppName=Interceptor
AppVersion={#AppVersion}
AppPublisher=Hacker Valley Media
AppPublisherURL=https://github.com/Hacker-Valley-Media/Interceptor
AppSupportURL=https://github.com/Hacker-Valley-Media/Interceptor/issues
AppUpdatesURL=https://github.com/Hacker-Valley-Media/Interceptor/releases
DefaultDirName={localappdata}\Programs\Interceptor
DefaultGroupName=Interceptor
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\release
OutputBaseFilename=Interceptor-{#AppVersion}-windows-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\interceptor.exe
UninstallDisplayName=Interceptor {#AppVersion}
InfoAfterFile=post-install.txt

[Tasks]
Name: addtopath; Description: "Add Interceptor to your user PATH"; GroupDescription: "Additional integrations:"
; link the browser-surface skill packs into Claude Code's skills
; directory (%USERPROFILE%\.claude\skills). Junctions — created by
; `interceptor skills adopt` — need neither Developer Mode nor elevation.
; Windows is browser-only, so only the router + browser skills ship here.
Name: linkskills; Description: "Link Interceptor AI skill packs into %USERPROFILE%\.claude\skills (Claude Code)"; GroupDescription: "Additional integrations:"

[Files]
Source: "..\..\dist\interceptor.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\daemon\interceptor-daemon.exe"; DestDir: "{app}\daemon"; Flags: ignoreversion
Source: "..\..\extension\dist\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
; Skill packs — resolved by the CLI's skills verb at {app}\skills
Source: "..\..\.agents\skills\interceptor\*"; DestDir: "{app}\skills\interceptor"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\.agents\skills\interceptor-browser\*"; DestDir: "{app}\skills\interceptor-browser"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\.agents\skills\interceptor-research\*"; DestDir: "{app}\skills\interceptor-research"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
; Runs as the installing user (per-user install, no elevation) so the junctions
; land in the right profile. Codex users: `interceptor skills adopt --into codex`.
Filename: "{app}\interceptor.exe"; Parameters: "skills adopt --all --into claude"; Flags: runhidden; Tasks: linkskills

[Registry]
; Native messaging host registration. Points each Chromium-family browser
; at the JSON manifest we render in CurStepChanged(ssPostInstall) — the
; manifest has to carry the absolute path to interceptor-daemon.exe, which
; we only know at install time.
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host"; ValueType: string; ValueName: ""; ValueData: "{app}\com.interceptor.host.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host"; ValueType: string; ValueName: ""; ValueData: "{app}\com.interceptor.host.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.interceptor.host"; ValueType: string; ValueName: ""; ValueData: "{app}\com.interceptor.host.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: files; Name: "{app}\com.interceptor.host.json"

[Code]
const
  EnvironmentKey = 'Environment';

procedure RenderNativeMessagingManifest();
var
  Manifest, DaemonPath: string;
begin
  DaemonPath := ExpandConstant('{app}\daemon\interceptor-daemon.exe');
  StringChangeEx(DaemonPath, '\', '\\', True);
  Manifest :=
    '{' + #13#10 +
    '  "name": "com.interceptor.host",' + #13#10 +
    '  "description": "Interceptor daemon bridge",' + #13#10 +
    '  "path": "' + DaemonPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": [' + #13#10 +
    '    "chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng/",' + #13#10 +
    '    "chrome-extension://clcflogdlhfnlibdiahigikhpnlmhnpl/",' + #13#10 +
    '    "chrome-extension://icbmachoifbaiepkgmkdmiomnhmbgigi/"' + #13#10 +
    '  ]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ExpandConstant('{app}\com.interceptor.host.json'), Manifest, False);
end;

function GetUserPath(): string;
var
  Existing: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Existing) then
    Existing := '';
  Result := Existing;
end;

function PathContains(Hay, Needle: string): Boolean;
begin
  Hay := ';' + Lowercase(Hay) + ';';
  Needle := ';' + Lowercase(Needle) + ';';
  Result := Pos(Needle, Hay) > 0;
end;

procedure AddToUserPath();
var
  Existing, AppDir: string;
begin
  AppDir := ExpandConstant('{app}');
  Existing := GetUserPath();
  if PathContains(Existing, AppDir) then
    Exit;
  if (Length(Existing) > 0) and (Existing[Length(Existing)] <> ';') then
    Existing := Existing + ';';
  Existing := Existing + AppDir;
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Existing);
end;

procedure RemoveFromUserPath();
var
  Existing, AppDir, Working: string;
begin
  AppDir := ExpandConstant('{app}');
  Existing := GetUserPath();
  if Length(Existing) = 0 then Exit;
  Working := ';' + Existing + ';';
  StringChangeEx(Working, ';' + AppDir + ';', ';', True);
  if (Length(Working) > 0) and (Working[1] = ';') then
    Working := Copy(Working, 2, Length(Working));
  if (Length(Working) > 0) and (Working[Length(Working)] = ';') then
    Working := Copy(Working, 1, Length(Working) - 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Working);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RenderNativeMessagingManifest();
    if WizardIsTaskSelected('addtopath') then
      AddToUserPath();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath();
end;
