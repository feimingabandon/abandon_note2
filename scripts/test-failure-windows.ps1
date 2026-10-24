# Read-only collector launched by test-runner, outside a blocked Electron loop.
param([switch]$CompileOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
function Property($Value, [string]$Name) {
    $item = $Value.PSObject.Properties[$Name]
    if ($null -eq $item) { return $null }
    return $item.Value
}
function SamePath([string]$Left, [string]$Right) {
    return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
}
function BindIdentity($Expected) {
    $live = Get-Process -Id $Expected.ProcessId -ErrorAction Stop
    $actual = $live.StartTime.ToUniversalTime().ToFileTimeUtc()
    # CIM's DMTF timestamp has microsecond precision; GetProcessTimes retains
    # all 100 ns ticks. Bind the exact value once after checking that rounding.
    if ($live.HasExited -or [Math]::Abs($actual - $Expected.CreationDate.ToUniversalTime().ToFileTimeUtc()) -ge 10) {
        throw 'The discovered process exited or its identity changed.'
    }
    $Expected | Add-Member -NotePropertyName ExactCreationFileTime -NotePropertyValue $actual
}
function AssertAlive($Expected) {
    $live = Get-Process -Id $Expected.ProcessId -ErrorAction Stop
    if ($live.HasExited -or $live.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $Expected.ExactCreationFileTime) {
        throw 'The owned process exited or its identity changed.'
    }
}
try {
    if (-not [Environment]::Is64BitProcess -or $env:OS -ne 'Windows_NT') { throw 'Windows x64 is required.' }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace AbandonTestDiagnostics {
    public sealed class DialogWindow {
        public long Handle;
        public long Owner;
        public uint ProcessId;
        public string ClassName;
        public string Text;
        public bool Visible;
        public string TextStatus;
        public List<DialogWindow> Children = new List<DialogWindow>();
    }
    public static class DialogReader {
        delegate bool EnumCallback(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder value, int count);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder value, int count);
        [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out UIntPtr result);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);

        public static string[] Arguments(string commandLine) {
            int count;
            IntPtr argv = CommandLineToArgvW(commandLine, out count);
            if (argv == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                var result = new string[count];
                for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i*IntPtr.Size));
                return result;
            } finally { LocalFree(argv); }
        }
        static void CheckProcess(IntPtr process, long expectedCreation) {
            long created, exited, kernel, user;
            if (WaitForSingleObject(process, 0) != 258 ||
                !GetProcessTimes(process, out created, out exited, out kernel, out user) || created != expectedCreation)
                throw new InvalidOperationException("The validated test process exited or its identity changed.");
        }
        static DialogWindow ReadWindow(IntPtr process, long created, uint target, IntPtr window, bool child) {
            CheckProcess(process, created);
            uint actual;
            GetWindowThreadProcessId(window, out actual);
            if (actual != target) return null;
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            string name = className.ToString();
            if (child && name != "Static" && name != "Button") return null;
            // Recheck identity immediately before reading any caption/control text.
            CheckProcess(process, created);
            GetWindowThreadProcessId(window, out actual);
            if (actual != target) return null;
            var text = new StringBuilder(1024);
            string status = "caption";
            if (child) {
                UIntPtr length;
                // WM_GETTEXT is read-only. A bounded call cannot click, close or confirm a dialog.
                IntPtr ok = SendMessageTimeout(window, 0x000D, (UIntPtr)text.Capacity, text, 0x0003, 250, out length);
                status = ok == IntPtr.Zero ? "unavailable-or-timeout" : "WM_GETTEXT";
            } else GetWindowText(window, text, text.Capacity);
            return new DialogWindow { Handle=window.ToInt64(), Owner=GetWindow(window, 4).ToInt64(),
                ProcessId=actual, ClassName=name, Text=text.ToString(), Visible=IsWindowVisible(window), TextStatus=status };
        }
        public static List<DialogWindow> Capture(int processId, long expectedCreation) {
            IntPtr process = OpenProcess(0x00101000, false, processId); // synchronize + query limited information only
            if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                CheckProcess(process, expectedCreation);
                var result = new List<DialogWindow>();
                Exception failure = null;
                EnumWindows(delegate(IntPtr window, IntPtr unused) {
                    try {
                        if (result.Count >= 32) return false;
                        var entry = ReadWindow(process, expectedCreation, (uint)processId, window, false);
                        if (entry == null) return true;
                        if (entry.ClassName == "#32770") {
                            EnumChildWindows(window, delegate(IntPtr control, IntPtr ignored) {
                                try {
                                    if (entry.Children.Count >= 16) return false;
                                    var item = ReadWindow(process, expectedCreation, (uint)processId, control, true);
                                    if (item != null) entry.Children.Add(item);
                                    return true;
                                } catch (Exception error) { failure=error; return false; }
                            }, IntPtr.Zero);
                        }
                        if (failure != null) return false;
                        result.Add(entry);
                        return true;
                    } catch (Exception error) { failure=error; return false; }
                }, IntPtr.Zero);
                if (failure != null) throw failure;
                CheckProcess(process, expectedCreation);
                return result;
            } finally { CloseHandle(process); }
        }
    }
}
'@
    if ($CompileOnly) { Write-Output '{"version":1,"status":"compiled","processOpened":false}'; exit 0 }
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 65536) { throw 'Diagnostic request exceeds its limit.' }
    $request = $inputText | ConvertFrom-Json
    if ($request.version -ne 1 -or [long]$request.rootPid -le 0 -or [long]$request.runnerPid -le 0) { throw 'Invalid diagnostic request.' }
    $rootPidValue = [int]$request.rootPid
    $collectorProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
    if ($collectorProcess.ParentProcessId -ne [int]$request.runnerPid) { throw 'Collector was not launched by the claimed runner.' }
    if (-not [IO.Path]::IsPathRooted($request.command)) { throw 'The runner must bind an absolute executable path.' }
    $launch = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.spawnedMs).UtcDateTime
    $age = ([DateTime]::UtcNow - $launch).TotalSeconds
    if ($age -lt -2 -or $age -gt 1800) { throw 'The launch is outside the bounded test lifetime.' }
    $root = Get-CimInstance Win32_Process -Filter "ProcessId = $rootPidValue"
    $rootExit = Property $request 'rootExitAtMs'
    $owned = New-Object 'System.Collections.Generic.List[object]'
    $rootState = 'alive'
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    if ($null -ne $root) {
        if ($root.ParentProcessId -ne [int]$request.runnerPid -or -not (SamePath $root.ExecutablePath $request.command)) { throw 'Root PID is not this runner child.' }
        if ([Math]::Abs(($root.CreationDate.ToUniversalTime() - $launch).TotalSeconds) -gt 2) { throw 'Root PID creation does not match the test launch.' }
        $actualArgs = [AbandonTestDiagnostics.DialogReader]::Arguments($root.CommandLine)
        $expectedArgs = @($request.args)
        if ($actualArgs.Length -ne $expectedArgs.Count + 1) { throw 'Root command line changed.' }
        for ($argIndex = 0; $argIndex -lt $expectedArgs.Count; $argIndex++) {
            if ($actualArgs[$argIndex + 1] -cne [string]$expectedArgs[$argIndex]) { throw 'Root command line does not match the runner spawn.' }
        }
        BindIdentity $root
        $owned.Add($root)
        $queue.Enqueue($root)
    } elseif ($null -ne $rootExit) {
        $rootState = 'exited'
        $ended = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$rootExit).UtcDateTime
        if ($ended -lt $launch -or $ended -gt [DateTime]::UtcNow.AddSeconds(2)) { throw 'Invalid runner-owned root exit time.' }
        # Spawn/exit events bind this now-gone PID's lifetime. Only direct
        # children created during that interval can seed an orphan subtree.
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $rootPidValue")) {
            $created = $child.CreationDate.ToUniversalTime()
            if ($created -ge $launch -and $created -le $ended -and $owned.Count -lt 24) {
                try { BindIdentity $child } catch { continue }
                $owned.Add($child)
                $queue.Enqueue($child)
            }
        }
    } else { throw 'The root exited before ownership could be verified.' }
    $seen = @{}
    foreach ($item in $owned) { $seen[[int]$item.ProcessId] = $true }
    while ($queue.Count -gt 0 -and $owned.Count -lt 24) {
        $parent = $queue.Dequeue()
        try { AssertAlive $parent } catch { continue }
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.ProcessId)")) {
            if ($seen.ContainsKey([int]$child.ProcessId) -or $child.CreationDate.ToUniversalTime() -lt $parent.CreationDate.ToUniversalTime()) { continue }
            if ($owned.Count -ge 24) { break }
            try { BindIdentity $child } catch { continue }
            $owned.Add($child)
            $seen[[int]$child.ProcessId] = $true
            $queue.Enqueue($child)
        }
    }
    $focus = [int]$request.focusPid
    if ($focus -ne $rootPidValue -and -not $seen.ContainsKey($focus)) { throw 'Lifecycle PID is not a verified descendant of this test.' }
    $processes = @()
    $windows = @()
    foreach ($item in $owned) {
        try {
            AssertAlive $item
            $identity = $item.ExactCreationFileTime
            $captured = [AbandonTestDiagnostics.DialogReader]::Capture([int]$item.ProcessId, $identity)
            $windows += $captured.ToArray()
            $processes += [pscustomobject]@{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId; executable = $item.ExecutablePath; createdUtc = $item.CreationDate.ToUniversalTime().ToString('o'); status = 'verified' }
        } catch {
            $processes += [pscustomobject]@{ pid = [int]$item.ProcessId; status = 'exited-or-unavailable'; reason = $_.Exception.Message }
        }
    }
    $result = [ordered]@{ version = 1; status = 'partial'; rootPid = $rootPidValue; rootState = $rootState; focusPid = $focus; capturedAt = [DateTime]::UtcNow.ToString('o'); processes = $processes; windows = $windows; dialogAutomation = @(); limits = @{ maxProcesses = 24; maxWindowsPerProcess = 32; maxNativeControls = 16; maxAutomationElements = 64; commandLinesOmitted = $true }; readOnly = $true }
    # Emit a native snapshot before a UIA provider can block the collector.
    Write-Output ([pscustomobject]$result | ConvertTo-Json -Depth 9 -Compress)
    [Console]::Out.Flush()
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $automation = @()
    foreach ($window in @($windows | Where-Object { $_.ClassName -eq '#32770' } | Select-Object -First 8)) {
        $dialogResult = [ordered]@{ handle = $window.Handle; pid = $window.ProcessId; status = 'pending'; elements = @() }
        try {
            $expected = $owned | Where-Object { $_.ProcessId -eq $window.ProcessId } | Select-Object -First 1
            AssertAlive $expected
            $elementRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.Handle)
            $pidProperty = [System.Windows.Automation.AutomationElement]::ProcessIdProperty
            if ([int]$elementRoot.GetCurrentPropertyValue($pidProperty) -ne [int]$window.ProcessId) { throw 'Dialog HWND identity changed.' }
            $condition = New-Object System.Windows.Automation.PropertyCondition($pidProperty, [int]$window.ProcessId)
            $elements = $elementRoot.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condition)
            $read = @()
            for ($elementIndex = 0; $elementIndex -lt [Math]::Min($elements.Count, 64); $elementIndex++) {
                AssertAlive $expected
                $element = $elements[$elementIndex]
                if ([int]$element.GetCurrentPropertyValue($pidProperty) -ne [int]$window.ProcessId) { continue }
                $name = [string]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
                if ($name.Length -gt 8192) { $name = $name.Substring(0, 8192) }
                $entry = [ordered]@{ pid = [int]$window.ProcessId; name = $name; controlType = $element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ControlTypeProperty).ProgrammaticName }
                [object]$pattern = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { $entry.text = $pattern.DocumentRange.GetText(8192) }
                $read += [pscustomobject]$entry
            }
            $dialogResult.elements = $read
            $dialogResult.truncated = $elements.Count -gt 64
            $dialogResult.status = 'complete'
        } catch { $dialogResult.status = 'unavailable'; $dialogResult.reason = $_.Exception.Message }
        $automation += [pscustomobject]$dialogResult
    }
    $result.dialogAutomation = $automation
    $result.status = 'complete'
    Write-Output ([pscustomobject]$result | ConvertTo-Json -Depth 9 -Compress)
} catch {
    [pscustomobject]@{ version = 1; status = 'refused-or-unavailable'; reason = $_.Exception.Message; readOnly = $true } | ConvertTo-Json -Compress
    exit 1
}
