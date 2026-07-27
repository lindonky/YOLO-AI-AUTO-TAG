#define MyAppName "YOLO Auto-Tag"
#define MyAppVersion "0.1"
#define MyAppVersionLabel "V0.1"
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
OutputBaseFilename=YOLO_Auto_Tag_V0.1_Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=..\assets\app_icon.ico
InfoBeforeFile=安装前说明.txt
VersionInfoVersion=0.1.0.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion=0.1.0.0
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
  AuthorLabel: TNewStaticText;

function IsWebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
end;

procedure InitializeWizard;
begin
  AuthorLabel := TNewStaticText.Create(WizardForm);
  AuthorLabel.Parent := WizardForm;
  AuthorLabel.Caption := '作者：{#MyAppPublisher}  |  邮箱：{#MyAppContact}';
  AuthorLabel.Font.Color := clGray;
  AuthorLabel.Font.Size := 8;
  AuthorLabel.Left := ScaleX(12);
  AuthorLabel.Top := WizardForm.ClientHeight - ScaleY(23);
  AuthorLabel.AutoSize := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
#if !FileExists("MicrosoftEdgeWebview2Setup.exe")
  if not IsWebView2Installed then
    Result := '当前电脑没有检测到 Microsoft Edge WebView2 Runtime，且测试安装包未包含 WebView2 安装器。请先安装 WebView2 后再继续。';
#endif
end;
