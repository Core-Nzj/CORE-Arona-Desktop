param(
  [ValidateSet('list', 'hide', 'show', 'close')][string]$Action = 'list',
  [int]$TargetPid = 0
)

$ErrorActionPreference = 'Stop'

# This helper is Windows-only, and is invoked by the Electron main process.
# It can only operate on a process whose executable name is exactly VoiSona Talk.exe.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AronaVoiSonaWindows {
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

function Find-Windows([int]$processId) {
  $handles = New-Object 'System.Collections.Generic.List[System.IntPtr]'
  $callback = [AronaVoiSonaWindows+EnumWindowsProc] {
    param([IntPtr]$window, [IntPtr]$data)
    [uint32]$windowPid = 0
    [void][AronaVoiSonaWindows]::GetWindowThreadProcessId($window, [ref]$windowPid)
    if ($windowPid -eq [uint32]$processId -and
        [AronaVoiSonaWindows]::GetWindow($window, 4) -eq [IntPtr]::Zero -and
        [AronaVoiSonaWindows]::GetWindowTextLength($window) -gt 0) {
      [void]$handles.Add($window)
    }
    return $true
  }
  [void][AronaVoiSonaWindows]::EnumWindows($callback, [IntPtr]::Zero)
  return ,$handles
}

if ($Action -eq 'list') {
  $items = @()
  foreach ($proc in @(Get-Process -Name 'VoiSona Talk' -ErrorAction SilentlyContinue)) {
    $handles = Find-Windows $proc.Id
    $visible = $false
    foreach ($handle in $handles) {
      if ([AronaVoiSonaWindows]::IsWindowVisible($handle)) { $visible = $true }
    }
    $items += [pscustomobject]@{
      pid = [int]$proc.Id
      hasWindow = $handles.Count -gt 0
      visible = $visible
    }
  }
  [pscustomobject]@{ processes = @($items) } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if ($TargetPid -le 0) { throw 'A positive process ID is required' }
$target = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $target -or $target.ProcessName -ne 'VoiSona Talk') {
  throw 'VoiSona Talk process not found'
}
$windows = Find-Windows $TargetPid
if ($windows.Count -eq 0) { throw 'VoiSona Talk main window is not ready' }

foreach ($window in $windows) {
  if ($Action -eq 'hide') {
    [void][AronaVoiSonaWindows]::ShowWindowAsync($window, 0) # SW_HIDE
  } elseif ($Action -eq 'show') {
    [void][AronaVoiSonaWindows]::ShowWindowAsync($window, 9) # SW_RESTORE
    [void][AronaVoiSonaWindows]::SetForegroundWindow($window)
  } elseif ($Action -eq 'close') {
    # Graceful WM_CLOSE; never force-terminate or discard unsaved work.
    [void][AronaVoiSonaWindows]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
[pscustomobject]@{ ok = $true; pid = $TargetPid; action = $Action } | ConvertTo-Json -Compress
