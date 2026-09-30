# Abandon capture runtime

Windows 10 22H2 / Windows 11 x64. C++20, Qt **6.8.3** (Widgets, Gui, Network,
Test and image formats), MSVC 2022-compatible ABI, dynamic MSVC runtime.
Visual Studio 2022 or newer C++ tools and CMake 3.24+ are required to build.

Install Qt into the ignored project toolchain directory, pass `-QtRoot`, or set
`QT_ROOT_DIR` (also used by the Windows CI Qt setup):

```powershell
python -m pip install aqtinstall==3.3.0
python -m aqt install-qt windows desktop 6.8.3 win64_msvc2022_64 --outputdir tmp/toolchains/qt --archives qtbase qtimageformats qttools
powershell -NoProfile -File native_capture/build.ps1 -Test
```

The app loads only `capture_host.dll`. Qt runs in the owned `AbandonCapture.exe`
process. `deploy/` contains the distributable runtime; no development PATH is
needed by the installed application. Qt is used under its applicable LGPL/GPL
licenses, consistent with this GPL-3.0-only repository. Include Qt license texts
with redistribution. See the screenshot design and test charter under `docs/`.

The default capture shortcut is F1; view visibility defaults to F2. Both can be
changed in application settings. Startup registration conflicts appear in a
dialog. After releasing a key in another app, use Retry in that dialog or in
settings to register it again without restarting; recovery is not automatic.
The tray can disable/enable all app global shortcuts (capture and view visibility)
without clearing their bindings for this run; restarting enables them again. Clipboard
pinning and showing/hiding pins are tray actions only, without global shortcuts.
Capture: Ctrl+A/F selects the screen; Enter/double click/Ctrl+C copies;
middle click/Ctrl+T pins; Ctrl+S saves and Ctrl+Shift+S quick-saves (the first use
asks for a directory). Ctrl+Enter uses a note/background capture in its source
form. Ctrl+N/B sends a global capture to a new note/background. Arrows move one
image pixel; Ctrl+arrows expand an edge and Shift+arrows shrink it. Hold Space
during selection dragging to move; otherwise Space toggles the toolbar. Tab
switches window/control detection, Alt shows the magnifier, C copies its color,
Shift toggles HEX/RGB, WASD moves the cursor, and R recalls the last successful
region until screen topology/DPI changes.

`AnnotationEditor` and `ImageDocument` are shared by capture and pins. Drawing
release leaves the current object editable; right click completes it. Ctrl+Z
undoes, Ctrl+Y redoes into the editable state, Ctrl+Shift+Z clears annotations.
Old completed objects are not directly selectable. Tools include rectangle,
ellipse, line/polyline, arrow, pen, marker, text, mosaic, blur and annotation-only
eraser. Text supports multiline IME input; Ctrl+Enter finishes text input while
keeping the object editable. Color, width/font/effect size and text rotation
are toolbar parameters. Wheel/1/2/[ / ] adjusts the applicable size.

Pins: Space/E opens the shared editor. Outside editing, drag to move, wheel/+/-
or the edges to resize, Ctrl+wheel or Ctrl+ +/- changes opacity, middle click
resets both. 1/2 rotates, 3/4 mirrors, Shift+double click toggles a thumbnail,
Shift+drag snaps to screen/other pins, arrows move one physical pixel. Export
includes annotations and content transforms, excluding view scale and opacity.
Esc/double click/Ctrl+W closes a pin; the tray restores the latest one (only
within this app run). Shift+Esc destroys it. Pin click-through and close-all are
not supported. Hidden and closed documents count toward the resource limit.

Window detection uses a frozen Z-order snapshot. Control detection reads only
rectangles through Windows UI Automation on a worker with provider timeouts;
manual selection remains available if a provider does not respond. No new Qt
module or third-party screenshot engine is needed.

Focused validation (after the native and electron-vite builds):

```powershell
# On this Codex host, prepend the bundled Node directory to PATH and use its node.exe.
node scripts/run-electron-window-tests.cjs capture
# Set ABANDON_CAPTURE_REAL_INPUT=1 for real native keyboard business acceptance.
node tests/capture-package-smoke.cjs tmp/capture-package-20260929/win-unpacked
```

Qt tests include an isolated Windows window station for clipboard tests, so they
do not replace the interactive user's clipboard. `capture_input_driver.exe` and
all test executables stay in build/bin and are never deployed. The package smoke
uses a temporary profile and localhost Inspector only for its own test process.
The helper intentionally has no standalone launch mode: it requires the host's
per-launch pipe/token/root, and the host creates it atomically inside a Job Object.
