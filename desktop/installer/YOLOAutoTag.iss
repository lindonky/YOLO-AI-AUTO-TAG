#define MyAppName "YOLO Auto-Tag"
#define MyAppVersion "1.2.7"
#define MyAppVersionLabel "V1.2.7"
#define MyAppPublisher "粥沫鱼块"
#define MyAppContact "2093880845@qq.com"
#define MyAppURL "https://github.com/lindonky/YOLO-AI-AUTO-TAG"
#define MyAppExeName "YOLOAutoTag.exe"

[Setup]
AppId={{7C3A8059-48B6-4A34-A58B-774733BEA77C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppContact={#MyAppContact}
DefaultDirName={localappdata}\Programs\YOLOAutoTag
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\output
OutputBaseFilename=YOLO_Auto_Tag_V1.2.7_Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=yes
CloseApplicationsFilter={#MyAppExeName}
RestartApplications=no
AppMutex=Local\YOLOAutoTagDesktop.SingleInstance
SetupMutex=Local\YOLOAutoTagInstaller
UsePreviousAppDir=yes
UsePreviousTasks=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=..\assets\app_icon.ico
InfoBeforeFile=安装前说明.txt
VersionInfoVersion=1.2.7.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion=1.2.7.0
VersionInfoCopyright=作者：{#MyAppPublisher}

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Messages]
WelcomeLabel1=欢迎安装 {#MyAppName}
WelcomeLabel2=版本：{#MyAppVersionLabel}%n%n安装程序将检查桌面运行环境，并把 {#MyAppName} 安装到当前 Windows 用户。%n%n首次启动后，需要由用户自行填写中转站 URL、API Key 和模型名称。%n%n项目仓库：lindonky/YOLO-AI-AUTO-TAG
FinishedHeadingLabel={#MyAppName} 安装完成
FinishedLabel=安装完成。首次启动时请填写自己的中转站 URL、API Key 和模型名称；在开始训练前，请人工抽查并复核 AI 标注结果。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Files]
Source: "..\dist\YOLOAutoTag\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "作者声明.txt"; DestDir: "{app}"; Flags: ignoreversion
#if FileExists("MicrosoftEdgeWebview2Setup.exe")
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
#endif

[InstallDelete]
; 清理早期测试版可能遗留的旧名称程序，用户配置位于 {localappdata}\YOLOAutoTag，不受影响。
Type: files; Name: "{app}\MyAutoTrain.exe"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
#if FileExists("MicrosoftEdgeWebview2Setup.exe")
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "正在安装 Microsoft Edge WebView2 Runtime…"; Flags: runhidden waituntilterminated; Check: not IsWebView2Installed
#endif
Filename: "{app}\{#MyAppExeName}"; Description: "运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
var
  PreviousInstallDetected: Boolean;
  PreviousVersion: String;
  PreviousInstallLocation: String;
  UpgradeNoticeAccepted: Boolean;

function DetectPreviousInstall: Boolean;
var
  UninstallKey: String;
begin
  UninstallKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C3A8059-48B6-4A34-A58B-774733BEA77C}_is1';
  Result := RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', PreviousVersion);
  if Result then
    RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', PreviousInstallLocation);

  if not Result then
  begin
    Result := RegQueryStringValue(HKLM32, UninstallKey, 'DisplayVersion', PreviousVersion);
    if Result then
      RegQueryStringValue(HKLM32, UninstallKey, 'InstallLocation', PreviousInstallLocation);
  end;

  if not Result then
  begin
    Result := RegQueryStringValue(HKLM64, UninstallKey, 'DisplayVersion', PreviousVersion);
    if Result then
      RegQueryStringValue(HKLM64, UninstallKey, 'InstallLocation', PreviousInstallLocation);
  end;

  if not Result then
  begin
    PreviousInstallLocation := ExpandConstant('{localappdata}\Programs\YOLOAutoTag');
    Result := FileExists(AddBackslash(PreviousInstallLocation) + '{#MyAppExeName}');
    if Result then
      PreviousVersion := '早期测试版';
  end;
end;

function InitializeSetup: Boolean;
begin
  PreviousInstallDetected := DetectPreviousInstall;
  UpgradeNoticeAccepted := False;
  Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Notice: String;
begin
  Result := True;
  if (CurPageID = wpReady) and PreviousInstallDetected and (not UpgradeNoticeAccepted) then
  begin
    if WizardSilent then
    begin
      UpgradeNoticeAccepted := True;
      Exit;
    end;
    Notice :=
      '检测到此电脑已经安装 YOLO Auto-Tag（版本：' + PreviousVersion + '）。' + #13#10 + #13#10 +
      '安装程序将执行安全覆盖升级：' + #13#10 +
      '1. 若旧版正在运行，安装会停止并提示先关闭程序；' + #13#10 +
      '2. 继续使用原安装目录，避免生成两套程序；' + #13#10 +
      '3. 保留本机 API 配置与用户设置；' + #13#10 +
      '4. 清理早期测试版可能残留的旧名称程序。' + #13#10 + #13#10 +
      '是否继续覆盖安装？';
    if MsgBox(Notice, mbConfirmation, MB_OKCANCEL) <> IDOK then
    begin
      Result := False;
      Exit;
    end;
    UpgradeNoticeAccepted := True;
  end;
end;

function IsWebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
#if !FileExists("MicrosoftEdgeWebview2Setup.exe")
  if not IsWebView2Installed then
    Result := '当前电脑没有检测到 Microsoft Edge WebView2 Runtime，且测试安装包未包含 WebView2 安装器。请先安装 WebView2 后再继续。';
#endif
end;
