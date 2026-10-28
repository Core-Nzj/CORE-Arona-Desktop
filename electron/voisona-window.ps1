param(
  [ValidateSet('list', 'hide', 'show', 'close')][string]$Action = 'list',
  [int]$TargetPid = 0,
  [string]$TargetHandle = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# Window enumeration only. The Electron main process selects one verified
# editor window. Never enumerate-and-show all JUCE/Windows Audio helper windows.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AronaVoiSonaWindows {
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

function Get-WindowInfo([IntPtr]$window) {
  $length = [AronaVoiSonaWindows]::GetWindowTextLength($window)
  if ($length -le 0 -or $length -gt 1000) { return $null }
  $titleBuffer = New-Object System.Text.StringBuilder ($length + 1)
  [void][AronaVoiSonaWindows]::GetWindowText($window, $titleBuffer, $titleBuffer.Capacity)
  $rect = [AronaVoiSonaWindows+RECT]::new()
  if (-not [AronaVoiSonaWindows]::GetWindowRect($window, [ref]$rect)) { return $null }
  $style = ([AronaVoiSonaWindows]::GetWindowLongPtr($window, -20)).ToInt64()
  return [pscustomobject]@{
    handle = $window.ToInt64().ToString()
    title = $titleBuffer.ToString()
    width = [Math]::Max(0, ($rect.Right - $rect.Left))
    height = [Math]::Max(0, ($rect.Bottom - $rect.Top))
    visible = [AronaVoiSonaWindows]::IsWindowVisible($window)
    toolWindow = ($style -band 0x80) -ne 0 # WS_EX_TOOLWINDOW
  }
}

function Find-Windows([int]$processId) {
  $items = New-Object 'System.Collections.Generic.List[object]'
  $callback = [AronaVoiSonaWindows+EnumWindowsProc] {
    param([IntPtr]$window, [IntPtr]$data)
    [uint32]$windowPid = 0
    [void][AronaVoiSonaWindows]::GetWindowThreadProcessId($window, [ref]$windowPid)
    if ($windowPid -eq [uint32]$processId -and
        [AronaVoiSonaWindows]::GetWindow($window, 4) -eq [IntPtr]::Zero) {
      $entry = Get-WindowInfo $window
      if ($null -ne $entry) { [void]$items.Add($entry) }
    }
    return $true
  }
  [void][AronaVoiSonaWindows]::EnumWindows($callback, [IntPtr]::Zero)
  return $items.ToArray()
}

if ($Action -eq 'list') {
  $items = @()
  foreach ($proc in @(Get-Process -Name 'VoiSona Talk' -ErrorAction SilentlyContinue)) {
    $items += [pscustomobject]@{
      pid = [int]$proc.Id
      windows = @(Find-Windows $proc.Id)
    }
  }
  [pscustomobject]@{ processes = @($items) } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($TargetPid -le 0) { throw 'A positive process ID is required' }
if ($TargetHandle -notmatch '^[1-9][0-9]{0,17}$') { throw 'A valid window handle is required' }
$target = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $target -or $target.ProcessName -ne 'VoiSona Talk') {
  throw 'VoiSona Talk process not found'
}
$window = [IntPtr]::new([long]::Parse($TargetHandle))
if (-not [AronaVoiSonaWindows]::IsWindow($window)) { throw 'Window no longer exists' }
[uint32]$windowPid = 0
[void][AronaVoiSonaWindows]::GetWindowThreadProcessId($window, [ref]$windowPid)
if ($windowPid -ne [uint32]$TargetPid -or
    [AronaVoiSonaWindows]::GetWindow($window, 4) -ne [IntPtr]::Zero) {
  throw 'Window does not belong to target process'
}
$info = Get-WindowInfo $window
# Also validate here, even if the renderer/controller was compromised or the
# original HWND got recycled between selection and command dispatch.
if ($null -eq $info -or $info.toolWindow -or $info.width -lt 500 -or
    $info.height -lt 300 -or $info.title -match '^(JUCEWindow|Windows Audio|DirectSound|JuceMidiDevice)') {
  throw 'Target is not a VoiSona main editor window'
}

if ($Action -eq 'hide') {
  [void][AronaVoiSonaWindows]::ShowWindowAsync($window, 0) # SW_HIDE
} elseif ($Action -eq 'show') {
  [void][AronaVoiSonaWindows]::ShowWindowAsync($window, 9) # SW_RESTORE
  [void][AronaVoiSonaWindows]::SetForegroundWindow($window)
} elseif ($Action -eq 'close') {
  # Graceful WM_CLOSE on only the main window. No force-termination.
  [void][AronaVoiSonaWindows]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
[pscustomobject]@{ ok = $true; pid = $TargetPid; handle = $TargetHandle; action = $Action } | ConvertTo-Json -Compress
