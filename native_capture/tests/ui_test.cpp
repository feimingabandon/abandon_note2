#include "CaptureEngine.h"
#include "DesktopCapture.h"
#include "SaveActions.h"
#include <QApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileDialog>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QProcess>
#include <QProcessEnvironment>
#include <QPushButton>
#include <QScopeGuard>
#include <QSettings>
#include <QSysInfo>
#include <QTemporaryDir>
#include <QTimer>
#include <QThread>
#include <QToolButton>
#include <QUuid>
#include <QXmlStreamReader>
#include <QtTest>
#include <cstdio>
#include <cstring>
#include <functional>
#include <windows.h>

namespace {
// Test-only observation: paint completion is a Qt callback boundary, not proof
// of a compositor-presented frame. All pixels supplied to this probe are synthetic.
class TimedCaptureOverlay final : public CaptureOverlay {
public:
  using CaptureOverlay::CaptureOverlay;
  QElapsedTimer *clock = nullptr;
  qint64 firstPaintStartedNs = -1, firstPaintFinishedNs = -1;

protected:
  void paintEvent(QPaintEvent *event) override {
    const bool first = firstPaintStartedNs < 0 && clock;
    if (first)
      firstPaintStartedNs = clock->nsecsElapsed();
    CaptureOverlay::paintEvent(event);
    if (first)
      firstPaintFinishedNs = clock->nsecsElapsed();
  }
};

class ForegroundGrantRecorder {
public:
  QStringList entries;
  std::function<void()> observed;
  ForegroundGrantRecorder() {
    current = this;
    previous = qInstallMessageHandler(record);
  }
  ~ForegroundGrantRecorder() {
    qInstallMessageHandler(previous);
    current = nullptr;
  }

private:
  inline static ForegroundGrantRecorder *current = nullptr;
  QtMessageHandler previous = nullptr;
  static void record(QtMsgType type, const QMessageLogContext &context,
                     const QString &message) {
    auto recorder = current;
    if (recorder && type == QtInfoMsg &&
        message.startsWith("capture.foreground-grant ")) {
      recorder->entries << message;
      if (recorder->observed)
        recorder->observed();
    }
    if (recorder && recorder->previous)
      recorder->previous(type, context, message);
    else
      std::fprintf(stderr, "%s\n", qPrintable(message));
  }
};

bool isolatedFeedbackCopy = false;
QString isolatedStationName, isolatedDesktopName;

QString userObjectName(HANDLE handle, DWORD *error = nullptr) {
  DWORD bytes = 0;
  GetUserObjectInformationW(handle, UOI_NAME, nullptr, 0, &bytes);
  const auto sizeError = GetLastError();
  if (!bytes || bytes % sizeof(wchar_t)) {
    if (error)
      *error = sizeError;
    return {};
  }
  QVector<wchar_t> name(bytes / sizeof(wchar_t));
  if (!GetUserObjectInformationW(handle, UOI_NAME, name.data(), bytes, &bytes)) {
    const auto nameError = GetLastError();
    if (error)
      *error = nameError;
    return {};
  }
  if (error)
    *error = 0;
  return QString::fromWCharArray(name.constData());
}

bool isolatedFeedbackDesktopReady() {
  USEROBJECTFLAGS flags{};
  DWORD bytes = 0;
  const auto station = GetProcessWindowStation();
  const auto actualStationName = userObjectName(station);
  return !isolatedStationName.isEmpty() && !isolatedDesktopName.isEmpty() &&
         actualStationName == isolatedStationName &&
         actualStationName.compare("WinSta0", Qt::CaseInsensitive) != 0 &&
         userObjectName(GetThreadDesktop(GetCurrentThreadId())) ==
             isolatedDesktopName &&
         GetUserObjectInformationW(station, UOI_FLAGS, &flags, sizeof(flags),
                                   &bytes) &&
         !(flags.dwFlags & WSF_VISIBLE);
}

void diagnosePrivateClipboardWrite(const QImage &source) {
  if (!isolatedFeedbackDesktopReady()) {
    qWarning("Private clipboard probe refused: isolation not verified");
    return;
  }
  auto record = [](const char *stage, bool ok, DWORD error) {
    qWarning().noquote()
        << QString("Private clipboard probe: stage=%1 success=%2 error=%3")
               .arg(stage).arg(ok).arg(ok ? 0 : error);
  };
  const auto image = source.convertToFormat(QImage::Format_ARGB32);
  const SIZE_T bytes = sizeof(BITMAPV5HEADER) + SIZE_T(image.sizeInBytes());
  SetLastError(ERROR_SUCCESS);
  auto memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
  const auto allocationError = GetLastError();
  record("GlobalAlloc", memory != nullptr, allocationError);
  if (!memory)
    return;
  auto releaseMemory = qScopeGuard([&] { if (memory) GlobalFree(memory); });
  SetLastError(ERROR_SUCCESS);
  auto header = static_cast<BITMAPV5HEADER *>(GlobalLock(memory));
  const auto lockError = GetLastError();
  record("GlobalLock", header != nullptr, lockError);
  if (!header)
    return;
  header->bV5Size = sizeof(BITMAPV5HEADER);
  header->bV5Width = image.width();
  header->bV5Height = -image.height();
  header->bV5Planes = 1;
  header->bV5BitCount = 32;
  header->bV5Compression = BI_BITFIELDS;
  header->bV5RedMask = 0x00ff0000;
  header->bV5GreenMask = 0x0000ff00;
  header->bV5BlueMask = 0x000000ff;
  header->bV5AlphaMask = 0xff000000;
  header->bV5CSType = LCS_sRGB;
  std::memcpy(header + 1, image.constBits(), size_t(image.sizeInBytes()));
  GlobalUnlock(memory);
  SetLastError(ERROR_SUCCESS);
  auto owner = CreateWindowExW(0, L"STATIC", L"Private clipboard diagnosis", 0,
                               0, 0, 0, 0, HWND_MESSAGE, nullptr, nullptr, nullptr);
  const auto ownerError = GetLastError();
  record("CreateWindowEx(message-owner)", owner != nullptr, ownerError);
  if (!owner)
    return;
  auto releaseOwner = qScopeGuard([&] { DestroyWindow(owner); });
  SetLastError(ERROR_SUCCESS);
  const bool opened = OpenClipboard(owner);
  const auto openError = GetLastError();
  record("OpenClipboard", opened, openError);
  if (!opened)
    return;
  auto closeClipboard = qScopeGuard([] { CloseClipboard(); });
  SetLastError(ERROR_SUCCESS);
  const bool emptied = EmptyClipboard();
  const auto emptyError = GetLastError();
  record("EmptyClipboard", emptied, emptyError);
  if (!emptied)
    return;
  SetLastError(ERROR_SUCCESS);
  const bool written = SetClipboardData(CF_DIBV5, memory) != nullptr;
  const auto writeError = GetLastError();
  record("SetClipboardData(CF_DIBV5)", written, writeError);
  if (written)
    memory = nullptr;
}

// Only the child uses this guard, before any QApplication or HWND exists.
// A separate desktop alone shares its window station's clipboard.
class FeedbackClipboardDesktop {
public:
  ~FeedbackClipboardDesktop() { close(); }
  bool open() {
    originalStation = GetProcessWindowStation();
    if (!recordStep("GetProcessWindowStation", originalStation != nullptr,
                    originalStation ? 0 : GetLastError()))
      return false;
    originalDesktop = GetThreadDesktop(GetCurrentThreadId());
    if (!recordStep("GetThreadDesktop", originalDesktop != nullptr,
                    originalDesktop ? 0 : GetLastError()))
      return false;
    DWORD nameError = 0;
    originalStationName = userObjectName(originalStation, &nameError);
    if (!recordStep("ReadOriginalStationName", !originalStationName.isEmpty(),
                    nameError))
      return false;
    const auto suffix = QUuid::createUuid().toString(QUuid::WithoutBraces);
    desktopName = "copy-" + suffix;
    // This logon may not create arbitrary named stations (ERROR_ACCESS_DENIED).
    // Ask Windows for its permitted noninteractive station, then prove the actual binding.
    // The station can be shared by this logon; GUI/clipboard suites must stay serial.
    station = CreateWindowStationW(nullptr, 0, WINSTA_ALL_ACCESS, nullptr);
    stationCreationError = GetLastError();
    if (!recordStep("CreateWindowStationW(system-named)", station != nullptr,
                    station ? 0 : stationCreationError))
      return false;
    stationName = userObjectName(station, &nameError);
    if (!recordStep("ReadPrivateStationName", !stationName.isEmpty(), nameError))
      return false;
    USEROBJECTFLAGS prebindFlags{};
    DWORD prebindBytes = 0;
    const bool prebindFlagsRead = GetUserObjectInformationW(
        station, UOI_FLAGS, &prebindFlags, sizeof(prebindFlags), &prebindBytes);
    if (!recordStep("GetPrivateStationFlagsBeforeBinding", prebindFlagsRead,
                    prebindFlagsRead ? 0 : GetLastError()))
      return false;
    prebindStationVerified = stationName != originalStationName &&
        stationName.compare("WinSta0", Qt::CaseInsensitive) != 0 &&
        !(prebindFlags.dwFlags & WSF_VISIBLE);
    if (!recordVerification("VerifyPrivateStationBeforeBinding",
                            prebindStationVerified,
                            "Private station must differ, exclude WinSta0 and be non-visible"))
      return false;
    stationBound = SetProcessWindowStation(station);
    if (!recordStep("SetProcessWindowStation", stationBound,
                    stationBound ? 0 : GetLastError()))
      return false;
    desktop = CreateDesktopW(desktopName.toStdWString().c_str(), nullptr,
                             nullptr, 0, GENERIC_ALL, nullptr);
    if (!recordStep("CreateDesktopW", desktop != nullptr,
                    desktop ? 0 : GetLastError()))
      return false;
    desktopBound = SetThreadDesktop(desktop);
    if (!recordStep("SetThreadDesktop", desktopBound,
                    desktopBound ? 0 : GetLastError()))
      return false;
    USEROBJECTFLAGS flags{};
    DWORD bytes = 0;
    const bool flagsRead = GetUserObjectInformationW(
        station, UOI_FLAGS, &flags, sizeof(flags), &bytes);
    if (!recordStep("GetUserObjectInformationW(UOI_FLAGS)", flagsRead,
                    flagsRead ? 0 : GetLastError()))
      return false;
    stationFlags = flags.dwFlags;
    observedStationName = userObjectName(GetProcessWindowStation(), &nameError);
    if (!recordStep("ReadBoundStationName", !observedStationName.isEmpty(),
                    nameError))
      return false;
    observedDesktopName =
        userObjectName(GetThreadDesktop(GetCurrentThreadId()), &nameError);
    if (!recordStep("ReadBoundDesktopName", !observedDesktopName.isEmpty(),
                    nameError))
      return false;
    stationVerified = observedStationName == stationName &&
                      stationName != originalStationName &&
                      stationName.compare("WinSta0", Qt::CaseInsensitive) != 0 &&
                      !(stationFlags & WSF_VISIBLE);
    desktopVerified = observedDesktopName == desktopName;
    return recordVerification("VerifyWindowStation", stationVerified,
                              "Actual station must differ and be non-visible") &&
           recordVerification("VerifyThreadDesktop", desktopVerified,
                              "Actual desktop must match this child fixture");
  }
  bool close() {
    bool complete = true;
    if (stationBound) {
      const bool restored = SetProcessWindowStation(originalStation);
      const auto error = restored ? 0 : GetLastError();
      recordStep("RestoreProcessWindowStation", restored, error);
      if (restored)
        stationBound = false;
      else {
        cleanupErrors << "Restore window station: " + QString::number(error);
        complete = false;
      }
    }
    if (desktopBound) {
      const bool restored = SetThreadDesktop(originalDesktop);
      const auto error = restored ? 0 : GetLastError();
      recordStep("RestoreThreadDesktop", restored, error);
      if (restored)
        desktopBound = false;
      else {
        cleanupErrors << "Restore thread desktop: " + QString::number(error);
        complete = false;
      }
    }
    if (desktop) {
      const bool closed = CloseDesktop(desktop);
      const auto error = closed ? 0 : GetLastError();
      recordStep("CloseDesktop", closed, error);
      if (closed)
        desktop = nullptr;
      else {
        cleanupErrors << "Close private desktop: " + QString::number(error);
        complete = false;
      }
    }
    if (station) {
      const bool closed = CloseWindowStation(station);
      const auto error = closed ? 0 : GetLastError();
      recordStep("CloseWindowStation", closed, error);
      if (closed)
        station = nullptr;
      else {
        cleanupErrors << "Close private station: " + QString::number(error);
        complete = false;
      }
    }
    return complete;
  }
  QJsonObject evidence() const {
    return {{"originalStation", originalStationName},
            {"station", stationName},
            {"desktop", desktopName},
            {"stationNaming", "system-logon-station"},
            {"stationCreationError", qint64(stationCreationError)},
            {"observedStation", observedStationName},
            {"observedDesktop", observedDesktopName},
            {"stationFlags", qint64(stationFlags)},
            {"prebindStationVerified", prebindStationVerified},
            {"stationVerified", stationVerified},
            {"desktopVerified", desktopVerified},
            {"failureStage", failureStage},
            {"failureWin32Error", qint64(failureWin32Error)},
            {"failureReason", failureReason},
            {"steps", steps},
            {"cleanupErrors", QJsonArray::fromStringList(cleanupErrors)}};
  }

private:
  HWINSTA originalStation = nullptr, station = nullptr;
  HDESK originalDesktop = nullptr, desktop = nullptr;
  QString originalStationName, stationName, desktopName, observedStationName,
      observedDesktopName, failureStage, failureReason;
  QStringList cleanupErrors;
  QJsonArray steps;
  DWORD stationCreationError = 0, stationFlags = 0, failureWin32Error = 0;
  bool stationBound = false, desktopBound = false;
  bool prebindStationVerified = false, stationVerified = false,
       desktopVerified = false;
  bool recordStep(const QString &stage, bool success, DWORD error) {
    steps.append(QJsonObject{{"stage", stage},
                             {"success", success},
                             {"win32Error", qint64(error)}});
    if (!success && failureStage.isEmpty()) {
      failureStage = stage;
      failureWin32Error = error;
    }
    return success;
  }
  bool recordVerification(const QString &stage, bool success,
                          const QString &reason) {
    recordStep(stage, success, 0);
    if (!success)
      failureReason = reason;
    return success;
  }
};

bool runIsolatedFeedbackCopy(QString *error) {
  const auto evidenceRoot =
      qEnvironmentVariable("ABANDON_CAPTURE_TEST_RESULT_DIRECTORY");
  QTemporaryDir evidence(
      QDir(evidenceRoot.isEmpty() ? QDir::tempPath() : evidenceRoot)
          .filePath("capture-ui-feedback-copy-XXXXXX"));
  if (!evidence.isValid()) {
    *error = "Cannot create the private copy-feedback evidence directory";
    return false;
  }
  // Preserve child evidence inside the current attempt, including failures.
  evidence.setAutoRemove(false);
  qInfo().noquote() << "Isolated copy-feedback evidence:" << evidence.path();
  const auto token = QUuid::createUuid().toString(QUuid::WithoutBraces);
  auto env = QProcessEnvironment::systemEnvironment();
  env.insert("ABANDON_CAPTURE_FEEDBACK_REPORT_DIRECTORY", evidence.path());
  env.insert("ABANDON_CAPTURE_FEEDBACK_RUN_TOKEN", token);
  env.insert("QT_QPA_PLATFORM", "windows");
  QProcess child;
  child.setWorkingDirectory(evidence.path());
  child.setProcessEnvironment(env);
  child.setStandardOutputFile(evidence.filePath("child.stdout.log"));
  child.setStandardErrorFile(evidence.filePath("child.stderr.log"));
  child.setCreateProcessArgumentsModifier(
      [](QProcess::CreateProcessArguments *args) {
        args->flags |= CREATE_NO_WINDOW;
      });
  auto ownedChildCleanup = qScopeGuard([&] {
    if (child.state() != QProcess::NotRunning) {
      child.kill();
      child.waitForFinished(5000);
    }
  });
  child.start(QCoreApplication::applicationFilePath(),
              {"--isolated-feedback-copy"});
  if (!child.waitForStarted(5000)) {
    *error = "Copy-feedback child launch failed: " + child.errorString();
    return false;
  }
  const auto pid = child.processId();
  if (!child.waitForFinished(20000)) {
    *error = "Copy-feedback child timed out; evidence: " + evidence.path();
    return false;
  }
  if (child.exitStatus() != QProcess::NormalExit || child.exitCode() != 0) {
    *error = "Copy-feedback child failed; evidence: " + evidence.path();
    QFile proof(evidence.filePath("isolation.json"));
    if (proof.open(QIODevice::ReadOnly) && proof.size() < 65536) {
      const auto report = QJsonDocument::fromJson(proof.readAll()).object();
      if (!report["failureStage"].toString().isEmpty())
        *error += "; stage=" + report["failureStage"].toString() +
                  "; Win32=" +
                  QString::number(report["failureWin32Error"].toInteger()) +
                  "; " + report["failureReason"].toString();
    }
    return false;
  }
  QFile proof(evidence.filePath("isolation.json"));
  QJsonParseError parseError;
  if (!proof.open(QIODevice::ReadOnly)) {
    *error = "Copy-feedback isolation report is missing";
    return false;
  }
  const auto document = QJsonDocument::fromJson(proof.readAll(), &parseError);
  const auto report = document.object();
  if (parseError.error != QJsonParseError::NoError || !document.isObject() ||
      report["version"].toInt() != 1 ||
      report["runToken"].toString() != token ||
      report["pid"].toInteger() != pid || !report["stationVerified"].toBool() ||
      !report["prebindStationVerified"].toBool() ||
      !report["desktopVerified"].toBool() ||
      report["station"].toString().isEmpty() ||
      report["station"] == report["originalStation"] ||
      !report["cleanupComplete"].toBool() ||
      report["qtestExitCode"].toInt(-1) != 0) {
    *error = "Copy-feedback isolation/completion/cleanup report is not proven";
    return false;
  }
  QFile junit(evidence.filePath("copy.junit.xml"));
  if (!junit.open(QIODevice::ReadOnly)) {
    *error = "Copy-feedback business report is missing";
    return false;
  }
  QXmlStreamReader xml(&junit);
  int businessCases = 0;
  bool suite = false, invalid = false;
  while (!xml.atEnd()) {
    xml.readNext();
    if (!xml.isStartElement())
      continue;
    const auto tag = xml.name();
    if (tag == QLatin1String("testsuite")) {
      if (suite || xml.attributes().value("name") != QLatin1String("UiTest"))
        invalid = true;
      suite = true;
    } else if (tag == QLatin1String("testcase")) {
      const auto name = xml.attributes().value("name");
      if (name == QLatin1String("completionFeedbackOutlivesOverlay"))
        ++businessCases;
      else if (name != QLatin1String("initTestCase") &&
               name != QLatin1String("cleanupTestCase"))
        invalid = true;
    } else if (tag == QLatin1String("failure") ||
               tag == QLatin1String("error") || tag == QLatin1String("skipped"))
      invalid = true;
  }
  if (xml.hasError() || !suite || invalid || businessCases != 1) {
    *error =
        "Copy-feedback needs exactly one completed, non-skipped business case";
    return false;
  }
  return true;
}
} // namespace

class UiTest : public QObject {
  Q_OBJECT
private:
  static void sendPeer(QLocalSocket &client, const QJsonObject &message) {
    client.write(QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n');
    client.flush();
  }
  bool connectPeer(CaptureEngine &engine, QLocalSocket &client) {
    client.connectToServer(engine.server.serverName());
    if (!QTest::qWaitFor([&] {
          return client.state() == QLocalSocket::ConnectedState &&
                 engine.socket;
        }))
      return false;
    // Keep the engine's revocation callbacks. Only production process-exit
    // notification is removed so a rejected peer cannot quit the test runner.
    QObject::disconnect(engine.socket, nullptr, qApp, nullptr);
    return true;
  }
  bool authenticatePeer(CaptureEngine &engine, QLocalSocket &client) {
    if (!connectPeer(engine, client))
      return false;
    sendPeer(client, {{"type", "hello"}, {"version", 1},
                      {"token", "token"}, {"pid", 1}});
    return QTest::qWaitFor([&] { return client.canReadLine(); }) &&
           QJsonDocument::fromJson(client.readLine()).object()["type"] ==
               "ready";
  }
  QJsonObject waitPeerMessage(QLocalSocket &client, const QString &type,
                              const QString &sessionId) {
    QJsonObject result;
    QTest::qWaitFor([&] {
      while (client.canReadLine()) {
        const auto message = QJsonDocument::fromJson(client.readLine()).object();
        if (message["type"].toString() == type &&
            message["sessionId"].toString() == sessionId) {
          result = message;
          return true;
        }
      }
      return false;
    });
    return result;
  }
private slots:
  void syntheticOverlayStartupTimings() {
    if (!Capture::interactiveDesktopAvailable())
      QSKIP("Overlay startup timing requires an unlocked interactive Windows desktop");
    auto screen = QGuiApplication::primaryScreen();
    QVERIFY(screen);
    const auto physical = Capture::nativeScreenRect(screen);
    QVERIFY(Capture::validImageSize(physical.size()));
    QSettings cpu("HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                  QSettings::NativeFormat);
    qInfo().noquote()
        << "capture.startup-timing.metadata"
        << QJsonDocument(QJsonObject{
               {"os", QSysInfo::prettyProductName()},
               {"architecture", QSysInfo::currentCpuArchitecture()},
               {"cpu", cpu.value("ProcessorNameString").toString().trimmed()},
               {"logicalProcessors", QThread::idealThreadCount()},
               {"qt", qVersion()},
               {"screenCount", QGuiApplication::screens().size()},
               {"physicalWidth", physical.width()},
               {"physicalHeight", physical.height()},
               {"logicalWidth", screen->geometry().width()},
               {"logicalHeight", screen->geometry().height()},
               {"devicePixelRatio", screen->devicePixelRatio()},
               {"fixedRoundsPerMode", 3},
               {"scope", "synthetic image; overlay constructor and show to completed Qt paint; excludes shortcut, host IPC/startup, screen acquisition and compositor presentation"},
               {"coldBoundary", "only the first normal-mode overlay is process-first; all later samples share Qt/font caches"}})
               .toJson(QJsonDocument::Compact);
    QImage synthetic(physical.size(), QImage::Format_ARGB32_Premultiplied);
    QVERIFY(!synthetic.isNull());
    synthetic.fill(QColor("#e8f0fa"));
    {
      QPainter p(&synthetic);
      p.setPen(QColor("#0071e3"));
      for (int x = 0; x < synthetic.width(); x += 64)
        p.drawLine(x, 0, x, synthetic.height());
      for (int y = 0; y < synthetic.height(); y += 64)
        p.drawLine(0, y, synthetic.width(), y);
    }
    const Capture::DesktopLayout layout{{{physical, screen->geometry()}}};
    // Fixed samples measure cache warming; failures end the test, never retry.
    for (int round = 0; round < 3; ++round) {
      for (bool quickCopy : {false, true}) {
        QElapsedTimer elapsed;
        elapsed.start();
        TimedCaptureOverlay overlay(screen, synthetic, "global", layout, {}, quickCopy);
        overlay.setAttribute(Qt::WA_DeleteOnClose, false);
        const auto constructorNs = elapsed.nsecsElapsed();
        overlay.clock = &elapsed;
        const auto showStartedNs = elapsed.nsecsElapsed();
        overlay.showDesktop();
        const auto showReturnedNs = elapsed.nsecsElapsed();
        const bool painted = QTest::qWaitFor([&] { return overlay.firstPaintFinishedNs >= 0; });
        qInfo().noquote()
            << "capture.startup-timing.sample"
            << QJsonDocument(QJsonObject{
                   {"round", round + 1},
                   {"mode", quickCopy ? "copyOnSelect" : "normal"},
                   {"processFirstOverlay", round == 0 && !quickCopy},
                   {"constructorMs", constructorNs / 1000000.0},
                   {"showCallMs", (showReturnedNs - showStartedNs) / 1000000.0},
                   {"showToPaintStartMs", overlay.firstPaintStartedNs < 0 ? -1.0 : (overlay.firstPaintStartedNs - showStartedNs) / 1000000.0},
                   {"showToPaintFinishedMs", overlay.firstPaintFinishedNs < 0 ? -1.0 : (overlay.firstPaintFinishedNs - showStartedNs) / 1000000.0},
                   {"constructorToPaintFinishedMs", overlay.firstPaintFinishedNs / 1000000.0},
                   {"painted", painted},
                   {"nativePlacementValid", overlay.placementValid}})
                   .toJson(QJsonDocument::Compact);
        QVERIFY2(painted, "Synthetic overlay did not complete its first Qt paint");
        QVERIFY(overlay.placementValid);
        overlay.hide();
      }
    }
  }
  void syntheticGaussianLargestRegionTiming() {
    // One fixed 4K case checks the new maximum strength and existing image
    // budget. This is a measurement, not a guessed responsiveness threshold.
    Capture::ImageDocument document;
    document.base = QImage(3840, 2160, QImage::Format_ARGB32_Premultiplied);
    QVERIFY(!document.base.isNull());
    document.base.fill(Qt::white);
    {
      QPainter p(&document.base);
      for (int x = 0; x < document.base.width(); x += 17)
        p.fillRect(x, 0, 5, document.base.height(), Qt::black);
    }
    document.append({"blur", {{0, 0}, {3839, 2159}}, Qt::black, 32});
    const auto workingBytes = document.gaussianWorkingCost(document.strokes.last());
    QVERIFY(document.memoryCost() + workingBytes <= Capture::MaxTotalBytes);
    QElapsedTimer elapsed;
    elapsed.start();
    const bool cached = document.cacheEffect(document.editable);
    const auto convolutionNs = elapsed.nsecsElapsed();
    QVERIFY(cached);
    elapsed.restart();
    const auto output = document.render();
    const auto cachedRenderNs = elapsed.nsecsElapsed();
    qInfo().noquote()
        << "capture.gaussian-timing.sample"
        << QJsonDocument(QJsonObject{
               {"width", 3840}, {"height", 2160}, {"strength", 32},
               {"workingBytes", workingBytes},
               {"retainedBytes", document.memoryCost()},
               {"budgetBytes", Capture::MaxTotalBytes},
               {"convolutionMs", convolutionNs / 1000000.0},
               {"cachedRenderMs", cachedRenderNs / 1000000.0},
               {"scope", "one fixed synthetic 4K region; synchronous release/strength-change work, independent of initial screenshot startup"}})
               .toJson(QJsonDocument::Compact);
    QVERIFY(!output.isNull());
    QVERIFY(output != document.base);
    QCOMPARE(output.size(), document.base.size());
  }
  void peerAuthenticationBindsKernelIdentity() {
    QTemporaryDir root;
    CaptureEngine engine("peer-auth-" + QUuid::createUuid().toString(),
                         "token", root.path());
    QLocalSocket client;
    QVERIFY(connectPeer(engine, client));
    QVERIFY(!engine.authenticated);
    QVERIFY(!engine.peerProcess);
    QCOMPARE(engine.peerPid, quint32(0));
    sendPeer(client, {{"type", "hello"}, {"version", 1},
                      {"token", "token"}, {"pid", 1}});
    QTRY_VERIFY(client.canReadLine());
    QCOMPARE(QJsonDocument::fromJson(client.readLine()).object()["type"],
             QJsonValue("ready"));
    QVERIFY(engine.authenticated);
    QVERIFY(engine.peerProcess);
    QCOMPARE(engine.peerSocket.data(), engine.socket.data());
    QCOMPARE(engine.peerGeneration, engine.socketGeneration);
    QCOMPARE(engine.peerPid, quint32(GetCurrentProcessId()));
    QCOMPARE(GetProcessId(static_cast<HANDLE>(engine.peerProcess)),
             GetCurrentProcessId());
    QCOMPARE(WaitForSingleObject(static_cast<HANDLE>(engine.peerProcess), 0),
             DWORD(WAIT_TIMEOUT));
  }
  void rejectedHelloDoesNotBindPeer_data() {
    QTest::addColumn<QString>("token");
    QTest::addColumn<int>("version");
    QTest::newRow("wrong-token") << QString("incorrect") << 1;
    QTest::newRow("wrong-version") << QString("token") << 2;
  }
  void rejectedHelloDoesNotBindPeer() {
    QFETCH(QString, token);
    QFETCH(int, version);
    QTemporaryDir root;
    CaptureEngine engine("peer-reject-" + QUuid::createUuid().toString(),
                         "token", root.path());
    QLocalSocket client;
    QVERIFY(connectPeer(engine, client));
    ForegroundGrantRecorder recorder;
    sendPeer(client, {{"type", "hello"}, {"version", version},
                      {"token", token}, {"pid", double(GetCurrentProcessId())}});
    QTRY_COMPARE(client.state(), QLocalSocket::UnconnectedState);
    QVERIFY(!engine.authenticated);
    QVERIFY(!engine.peerProcess);
    QVERIFY(engine.peerSocket.isNull());
    QCOMPARE(engine.peerPid, quint32(0));
    QCOMPARE(engine.peerGeneration, quint64(0));
    engine.session = "rejected-peer-session";
    engine.sessionGeneration = engine.socketGeneration;
    QJsonObject handoff{{"oldResult", true}};
    QVERIFY(!engine.grantPeerForeground(engine.session, "cancelled", &handoff));
    QCOMPARE(handoff["attempted"], QJsonValue(false));
    QCOMPARE(handoff["sessionId"].toString(), engine.session);
    QCOMPARE(handoff["generation"].toInteger(), qint64(engine.socketGeneration));
    QCOMPARE(handoff["reason"].toString(), QString("cancelled"));
    QVERIFY(handoff["pid"].isNull());
    QVERIFY(handoff["granted"].isNull());
    QVERIFY(handoff["win32Error"].isNull());
    QVERIFY(!handoff.contains("oldResult"));
    QVERIFY(recorder.entries.isEmpty());
  }
  void disconnectedAndReplacedPeerCannotInheritSessionPermission() {
    QTemporaryDir root;
    CaptureEngine engine("peer-replace-" + QUuid::createUuid().toString(),
                         "token", root.path());
    QLocalSocket client;
    QVERIFY(authenticatePeer(engine, client));
    QVERIFY(engine.peerProcess);
    const auto previousGeneration = engine.peerGeneration;
    engine.session = "old-peer-session";
    engine.sessionGeneration = previousGeneration;
    ForegroundGrantRecorder recorder;
    client.disconnectFromServer();
    QTRY_VERIFY(engine.socket.isNull());
    QVERIFY(!engine.authenticated);
    QVERIFY(!engine.peerProcess);
    QVERIFY(engine.peerSocket.isNull());
    QCOMPARE(engine.peerPid, quint32(0));
    QCOMPARE(engine.peerGeneration, quint64(0));
    QJsonObject handoff;
    QVERIFY(!engine.grantPeerForeground(engine.session, "cancelled", &handoff));
    QCOMPARE(handoff["attempted"], QJsonValue(false));
    QVERIFY(handoff["pid"].isNull());
    QVERIFY(handoff["granted"].isNull());

    QLocalSocket replacement;
    QVERIFY(authenticatePeer(engine, replacement));
    QVERIFY(engine.peerProcess);
    QVERIFY(engine.peerGeneration > previousGeneration);
    // Even the same live OS process on a new authenticated socket cannot
    // inherit foreground permission from the preceding capture generation.
    handoff = {{"oldResult", true}};
    QVERIFY(!engine.grantPeerForeground(engine.session, "cancelled", &handoff));
    QCOMPARE(handoff["attempted"], QJsonValue(false));
    QCOMPARE(handoff["generation"].toInteger(), qint64(engine.socketGeneration));
    QVERIFY(handoff["pid"].isNull());
    QVERIFY(handoff["granted"].isNull());
    QVERIFY(!handoff.contains("oldResult"));
    engine.finish("cancelled");
    QVERIFY(recorder.entries.isEmpty());
  }
  void businessOutputHandsOffBeforeHide_data() {
    QTest::addColumn<QString>("action");
    QTest::addColumn<bool>("retainedPeer");
    for (const auto action : {"note", "source", "background"})
      QTest::newRow(action) << QString(action) << true;
    QTest::newRow("note-without-peer-identity") << QString("note") << false;
  }
  void businessOutputHandsOffBeforeHide() {
    QFETCH(QString, action);
    QFETCH(bool, retainedPeer);
    QTemporaryDir root;
    CaptureEngine engine("peer-output-" + QUuid::createUuid().toString(),
                         "token", root.path());
    QLocalSocket client;
    QVERIFY(authenticatePeer(engine, client));
    QVERIFY(engine.peerProcess);
    if (!retainedPeer)
      engine.revokePeerIdentity();
    engine.session = QUuid::createUuid().toString(QUuid::WithoutBraces);
    engine.sessionGeneration = engine.socketGeneration;
    const auto sessionId = engine.session;
    QVERIFY(QDir(root.path()).mkdir(engine.session));
    QImage image(40, 30, QImage::Format_RGB32);
    image.fill(Qt::white);
    auto overlay =
        new CaptureOverlay(QGuiApplication::primaryScreen(), image, "note");
    overlay->selection = image.rect();
    engine.overlays << overlay;
    engine.selected = overlay;
    overlay->show();
    ForegroundGrantRecorder recorder;
    bool visibleAtHandoff = false;
    recorder.observed = [&] { visibleAtHandoff = overlay->isVisible(); };
    engine.output(overlay, action, image);
    QCOMPARE(recorder.entries.size(), retainedPeer ? 1 : 0);
    if (retainedPeer) {
      QVERIFY(visibleAtHandoff);
      QVERIFY(recorder.entries.first().contains("reason " + action));
    }
    QVERIFY(!overlay->isVisible());
    QTRY_VERIFY(client.canReadLine());
    const auto output = QJsonDocument::fromJson(client.readLine()).object();
    QCOMPARE(output["type"], QJsonValue("output"));
    QCOMPARE(output["action"], QJsonValue(action));
    QVERIFY(output["foregroundHandoff"].isObject());
    const auto handoff = output["foregroundHandoff"].toObject();
    QCOMPARE(handoff["attempted"], QJsonValue(retainedPeer));
    QCOMPARE(handoff["sessionId"].toString(), sessionId);
    QCOMPARE(handoff["generation"].toInteger(), qint64(engine.socketGeneration));
    QCOMPARE(handoff["reason"].toString(), action);
    if (retainedPeer) {
      QCOMPARE(handoff["pid"].toInteger(), qint64(GetCurrentProcessId()));
      QVERIFY(handoff["granted"].isBool());
      QVERIFY(handoff["win32Error"].isDouble());
      QVERIFY(recorder.entries.first().contains(
          QString("granted %1 win32Error %2")
              .arg(handoff["granted"].toBool() ? "true" : "false")
              .arg(handoff["win32Error"].toInteger())));
    } else {
      QVERIFY(handoff["pid"].isNull());
      QVERIFY(handoff["granted"].isNull());
      QVERIFY(handoff["win32Error"].isNull());
    }
    const auto path = QDir(root.path()).filePath(
        engine.session + "/" + output["deliveryId"].toString() + ".png");
    QCOMPARE(QImage(path), image);
    recorder.observed = {};
    sendPeer(client, {{"type", "ack"}, {"sessionId", engine.session},
                      {"deliveryId", output["deliveryId"]}, {"accepted", true}});
    QTRY_VERIFY(engine.session.isEmpty());
    QCOMPARE(recorder.entries.size(), retainedPeer ? 1 : 0);
    QVERIFY(!QFile::exists(path));
    const auto finished = waitPeerMessage(client, "finished", sessionId);
    QCOMPARE(finished["status"].toString(), QString("delivered"));
    QVERIFY(!finished.contains("foregroundHandoff"));
  }
  void backgroundFinishAndStaleOverlayNeverGrant() {
    QTemporaryDir root;
    CaptureEngine engine("peer-session-" + QUuid::createUuid().toString(),
                         "token", root.path());
    QLocalSocket client;
    QVERIFY(authenticatePeer(engine, client));
    QVERIFY(engine.peerProcess);
    ForegroundGrantRecorder recorder;
    const auto first = QUuid::createUuid().toString(QUuid::WithoutBraces);
    engine.capture({{"sessionId", first}, {"origin", "global"}});
    QVERIFY(!engine.overlays.isEmpty());
    const auto staleCancel = engine.overlays.first()->cancel;
    const auto staleOutput = engine.overlays.first()->output;
    // Exercise the real capture-installed closeEvent callback: finish clears
    // the session before closing the overlay, so this is not a user cancel.
    engine.finish("display-changed");
    QVERIFY(recorder.entries.isEmpty());
    staleCancel();
    QVERIFY(recorder.entries.isEmpty());

    const auto second = QUuid::createUuid().toString(QUuid::WithoutBraces);
    QVERIFY(QDir(root.path()).mkdir(second));
    engine.capture({{"sessionId", second}, {"origin", "global"}});
    QVERIFY(!engine.overlays.isEmpty());
    QPointer<CaptureOverlay> overlay = engine.overlays.first();
    QImage image(20, 30, QImage::Format_RGB32);
    image.fill(Qt::red);
    staleCancel();
    staleOutput("note", image);
    QCOMPARE(engine.session, second);
    QVERIFY(engine.delivery.isEmpty());
    QVERIFY(recorder.entries.isEmpty());
    const auto backgroundFinished = waitPeerMessage(client, "finished", first);
    QCOMPARE(backgroundFinished["status"].toString(), QString("display-changed"));
    QVERIFY(!backgroundFinished.contains("foregroundHandoff"));

    overlay->selectAll();
    overlay->output("note", image);
    QCOMPARE(recorder.entries.size(), 1);
    const auto delivery = engine.delivery;
    QVERIFY(!delivery.isEmpty());
    sendPeer(client, {{"type", "ack"}, {"sessionId", second},
                      {"deliveryId", delivery}, {"accepted", false},
                      {"message", "test rejection"}});
    QTRY_VERIFY(overlay->isVisible());
    QVERIFY(engine.delivery.isEmpty());
    QCOMPARE(recorder.entries.size(), 1);
    QTest::keyClick(overlay, Qt::Key_Escape);
    QTRY_VERIFY(engine.session.isEmpty());
    QCOMPARE(recorder.entries.size(), 2);
    QVERIFY(recorder.entries.last().contains("reason cancelled"));
    QTRY_VERIFY(overlay.isNull());
    const auto cancelled = waitPeerMessage(client, "finished", second);
    QCOMPARE(cancelled["status"].toString(), QString("cancelled"));
    QVERIFY(cancelled["foregroundHandoff"].isObject());
    const auto handoff = cancelled["foregroundHandoff"].toObject();
    QCOMPARE(handoff["attempted"], QJsonValue(true));
    QCOMPARE(handoff["pid"].toInteger(), qint64(GetCurrentProcessId()));
    QCOMPARE(handoff["generation"].toInteger(), qint64(engine.peerGeneration));
    QCOMPARE(handoff["sessionId"].toString(), second);
    QCOMPARE(handoff["reason"].toString(), QString("cancelled"));
    QVERIFY(handoff["granted"].isBool());
    QVERIFY(handoff["win32Error"].isDouble());
    QVERIFY(recorder.entries.last().contains(
        QString("granted %1 win32Error %2")
            .arg(handoff["granted"].toBool() ? "true" : "false")
            .arg(handoff["win32Error"].toInteger())));
    engine.receive({{"type", "ack"}, {"sessionId", second},
                    {"deliveryId", delivery}, {"accepted", true}});
    staleCancel();
    QCOMPARE(recorder.entries.size(), 2);
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
  }
  void completionReturnsToRequestingForm() {
    QImage base(240, 180, QImage::Format_RGB32);
    base.fill(Qt::white);
    for (const QString origin : {"global", "note", "background"}) {
      CaptureOverlay overlay(QGuiApplication::primaryScreen(), base, origin);
      overlay.selection = base.rect();
      const auto expected = origin == "global" ? QString("copy") : QString("source");
      QString action;
      overlay.output = [&](QString value, QImage) { action = value; };
      auto primary = overlay.annotations->outputs->findChild<QToolButton *>("capturePrimary");
      QVERIFY(primary);
      QCOMPARE(primary->defaultAction()->data().toString(), expected);
      primary->defaultAction()->trigger();
      QCOMPARE(action, expected);
      action.clear();
      QTest::keyClick(&overlay, Qt::Key_Return);
      QCOMPARE(action, expected);
      action.clear();
      QTest::mouseDClick(&overlay, Qt::LeftButton, Qt::NoModifier, QPoint(30, 30));
      QCOMPARE(action, expected);
      action.clear();
      QTest::keyClick(&overlay, Qt::Key_C, Qt::ControlModifier);
      QCOMPARE(action, QString("copy"));
    }
  }
  void completionFeedbackOutlivesOverlay() {
    if (!isolatedFeedbackCopy) {
      QString error;
      QVERIFY2(runIsolatedFeedbackCopy(&error), qPrintable(error));
    } else {
      QVERIFY(isolatedFeedbackDesktopReady());
      QCOMPARE(QGuiApplication::platformName(), QString("windows"));
      QVERIFY(QGuiApplication::primaryScreen());
    }
    QTemporaryDir temp;
    CaptureEngine engine("feedback-" + QUuid::createUuid().toString(), "token",
                         temp.filePath("run"));
    {
      QSettings prefs(engine.settingsPath, QSettings::IniFormat);
      prefs.setValue("quickSaveDirectory", temp.path());
    }
    QImage base(80, 60, QImage::Format_RGB32);
    base.fill(Qt::red);
    // The interactive process never reaches production clipboard writes.
    for (QString action : isolatedFeedbackCopy ? QStringList{"copy"}
                                               : QStringList{"quickSave"}) {
      auto overlay = new CaptureOverlay(QGuiApplication::primaryScreen(), base,
                                        "global", {}, {}, action == "copy");
      QPointer<CaptureOverlay> guard(overlay);
      overlay->selection = base.rect();
      engine.session = QUuid::createUuid().toString(QUuid::WithoutBraces);
      engine.selected = overlay;
      engine.overlays << overlay;
      HWND copyFixture = nullptr, copyActive = nullptr;
      bool copyQtVisible = false, copyOwnVisible = false;
      if (action == "copy") {
        QVERIFY(isolatedFeedbackDesktopReady());
        // Production capture shows and activates its overlay before copying.
        // Do the same on the verified private desktop, without switching desktops.
        overlay->showDesktop();
        overlay->raise();
        overlay->activateWindow();
        overlay->setFocus();
        copyFixture = reinterpret_cast<HWND>(overlay->winId());
        QVERIFY(IsWindow(copyFixture));
        QCOMPARE(GetWindowThreadProcessId(copyFixture, nullptr), GetCurrentThreadId());
        QVERIFY(isolatedFeedbackDesktopReady());
        for (auto entry : QList<QPair<QString, HWND>>{
                 {"fixture", copyFixture},
                 {"GetParent", GetParent(copyFixture)},
                 {"GW_OWNER", GetWindow(copyFixture, GW_OWNER)},
                 {"GA_PARENT", GetAncestor(copyFixture, GA_PARENT)},
                 {"GA_ROOT", GetAncestor(copyFixture, GA_ROOT)},
                 {"GA_ROOTOWNER", GetAncestor(copyFixture, GA_ROOTOWNER)},
                 {"desktop", GetDesktopWindow()}}) {
          DWORD windowPid = 0;
          const auto windowThread = GetWindowThreadProcessId(entry.second, &windowPid);
          qInfo().noquote()
              << QString("Private window chain: role=%1 hwnd=0x%2 style=0x%3 "
                         "visible=%4 thread=%5 pid=%6")
                     .arg(entry.first)
                     .arg(reinterpret_cast<quintptr>(entry.second), 0, 16)
                     .arg(quintptr(GetWindowLongPtrW(entry.second, GWL_STYLE)), 0, 16)
                     .arg(bool(IsWindowVisible(entry.second)))
                     .arg(windowThread).arg(windowPid);
        }
        qInfo() << "Private Qt screen:" << QGuiApplication::screens().size()
                << overlay->screen()->name() << overlay->screen()->geometry()
                << overlay->screen()->availableGeometry();
        // IsWindowVisible includes the deliberately hidden private desktop ancestor.
        // Require the fixture itself to be shown; actual copy completion is separate.
        copyQtVisible = overlay->isVisible();
        copyOwnVisible = (GetWindowLongPtrW(copyFixture, GWL_STYLE) & WS_VISIBLE) != 0;
        SetActiveWindow(copyFixture);
        copyActive = GetActiveWindow();
        QVERIFY(isolatedFeedbackDesktopReady());
        qInfo().noquote()
            << QString("Copy fixture on private desktop: hwnd=0x%1 active=0x%2 "
                       "qtVisible=%3 ownWS_VISIBLE=%4")
                   .arg(reinterpret_cast<quintptr>(copyFixture), 0, 16)
                   .arg(reinterpret_cast<quintptr>(copyActive), 0, 16)
                   .arg(copyQtVisible).arg(copyOwnVisible);
      }
      const auto activeBefore = GetActiveWindow();
      const auto foregroundBefore = GetForegroundWindow();
      const bool overlayVisibleBefore = overlay->isVisible();
      SetLastError(ERROR_SUCCESS);
      if (action == "copy") {
        overlay->selection = {};
        overlay->output = [&](QString selectedAction, QImage selectedImage) {
          QCOMPARE(selectedAction, QString("copy"));
          QCOMPARE(selectedImage, base);
          engine.output(overlay, selectedAction, selectedImage);
        };
        // QTest treats a null QPoint as the widget center. Use a real corner
        // coordinate.
        QTest::mousePress(overlay, Qt::LeftButton, Qt::NoModifier, {1, 1});
        QTest::mouseMove(overlay,
                         {overlay->width() - 1, overlay->height() - 1});
        QTest::mouseRelease(overlay, Qt::LeftButton, Qt::NoModifier,
                            {overlay->width(), overlay->height()});
      } else
        engine.output(overlay, action, base);
      const auto outputLastError = GetLastError();
      if (action == "copy" && !engine.session.isEmpty()) {
        QStringList hints;
        for (auto label : overlay->findChildren<QLabel *>(
                 QString(), Qt::FindDirectChildrenOnly))
          hints << label->text();
        qWarning().noquote()
            << QString("Copy completion failed: busy=%1 isolatedReady=%2 "
                       "overlayVisibleBefore=%3 activeBefore=0x%4 "
                       "foregroundBefore=0x%5 activeAfter=0x%6 "
                       "openClipboardWindow=0x%7 clipboardOwner=0x%8 "
                       "outputLastError=%9 hints=%10")
                   .arg(engine.busy)
                   .arg(isolatedFeedbackDesktopReady())
                   .arg(overlayVisibleBefore)
                   .arg(reinterpret_cast<quintptr>(activeBefore), 0, 16)
                   .arg(reinterpret_cast<quintptr>(foregroundBefore), 0, 16)
                   .arg(reinterpret_cast<quintptr>(GetActiveWindow()), 0, 16)
                   .arg(reinterpret_cast<quintptr>(GetOpenClipboardWindow()), 0, 16)
                   .arg(reinterpret_cast<quintptr>(GetClipboardOwner()), 0, 16)
                   .arg(outputLastError)
                   .arg(hints.join(" | "));
        diagnosePrivateClipboardWrite(base);
      }
      QVERIFY(engine.session.isEmpty());
      if (action == "copy") {
        QVERIFY(copyQtVisible);
        QVERIFY(copyOwnVisible);
        QCOMPARE(copyActive, copyFixture);
      }
      QTRY_VERIFY(guard.isNull());
      QVERIFY(engine.feedback.isVisible());
      const auto text = engine.feedback.findChild<QLabel *>()->text();
      if (action == "copy") {
        QCOMPARE(text, QStringLiteral("已复制到剪贴板"));
        QString error;
        QCOMPARE(Capture::readClipboardImage(&error),
                 base.convertToFormat(QImage::Format_ARGB32));
      } else {
        QVERIFY(text.startsWith(QStringLiteral("已保存\n")));
        const auto files = QDir(temp.path()).entryList({"*.png"}, QDir::Files);
        QCOMPARE(files.size(), 1);
        QVERIFY(text.contains(
            QDir::toNativeSeparators(temp.filePath(files.first()))));
        QCOMPARE(QImage(temp.filePath(files.first())), base);
      }
    }
    if (!isolatedFeedbackCopy && Capture::interactiveDesktopAvailable()) {
      engine.capture(
          {{"sessionId", QUuid::createUuid().toString(QUuid::WithoutBraces)},
           {"origin", "global"}});
      QVERIFY(!engine.feedback.isVisible());
      engine.finish("cancelled");
    }
  }
  void nativeControlDetection() {
    QWidget fixture(nullptr,
                    Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint);
    fixture.setGeometry(200, 200, 500, 300);
    QPushButton control("synthetic button", &fixture);
    control.setGeometry(80, 70, 200, 60);
    fixture.show();
    QTest::qWait(60);
    auto hwnd = reinterpret_cast<HWND>(fixture.winId());
    RECT native{};
    QVERIFY(GetWindowRect(hwnd, &native));
    POINT point{native.left + 100, native.top + 90};
    // Every completed query must release its UIA references and COM apartment
    // before admitting the next worker; retain the actual child-control checks.
    for (int attempt = 0; attempt < 3; ++attempt) {
      QRect result;
      QVERIFY(Capture::accessibleTarget(
          &fixture, fixture.winId(), QPoint(point.x, point.y),
          [&](QRect rect) { result = rect; }));
      QTRY_VERIFY_WITH_TIMEOUT(!result.isEmpty(), 4000);
      QVERIFY(result.contains(QPoint(point.x, point.y)));
      QVERIFY(result.width() < native.right - native.left);
      QVERIFY(result.height() < native.bottom - native.top);
    }
    auto targets = Capture::desktopTargets(fixture.screen());
    QVERIFY(std::any_of(targets.begin(), targets.end(),
                        [&](auto t) { return t.window == fixture.winId(); }));
  }
  void newTools_data() {
    QTest::addColumn<QString>("tool");
    for (auto tool : {"line", "marker", "mosaic", "eraser"})
      QTest::newRow(tool) << QString(tool);
  }
  void newTools() {
    QFETCH(QString, tool);
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    {
      QPainter p(&base);
      for (int x = 0; x < 800; x += 11)
        p.fillRect(x, 0, 4, 600, Qt::black);
    }
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selectAll();
    o.document.append({"pen", {{100, 160}, {300, 260}}, Qt::red, 24});
    o.document.editable = -1;
    auto original = o.document.render();
    o.annotations->choose(tool);
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {110, 170});
    QTest::mouseMove(&o, {300, 260});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {300, 260});
    if (tool == "polyline") {
      QTest::mouseClick(&o, Qt::LeftButton, Qt::NoModifier, {300, 260});
      QTest::mouseMove(&o, {180, 340});
      QTest::mouseClick(&o, Qt::LeftButton, Qt::NoModifier, {180, 340});
    }
    QVERIFY(o.annotations->hasCurrent());
    QVERIFY(o.document.render() != original);
    QTest::mouseClick(&o, Qt::RightButton, Qt::NoModifier, {500, 400});
    auto marked = o.document.render();
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(o.document.render(), original);
    QTest::keyClick(&o, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(o.document.render(), marked);
    o.findChild<QSpinBox *>("annotationSize")->setValue(30);
    QVERIFY(o.document.render() != marked);
    QCOMPARE(o.document.base, base);
  }
  void completionGestures_data() {
    QTest::addColumn<QString>("gesture");
    QTest::addColumn<QString>("expected");
    QTest::newRow("enter") << "enter" << "source";
    QTest::newRow("double") << "double" << "source";
    QTest::newRow("middle") << "middle" << "pin";
    QTest::newRow("source") << "source" << "source";
  }
  void completionGestures() {
    QFETCH(QString, gesture);
    QFETCH(QString, expected);
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "note");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selection = {100, 100, 400, 300};
    o.annotations->choose("arrow");
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {120, 130});
    QTest::mouseMove(&o, {230, 220});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {230, 220});
    auto expectedImage = o.document.render().copy(o.selection);
    QString action;
    QImage exported;
    o.output = [&](QString a, QImage image) {
      action = a;
      exported = image;
    };
    if (gesture == "double")
      QTest::mouseDClick(&o, Qt::LeftButton, Qt::NoModifier, {400, 300});
    if (gesture == "middle")
      QTest::mouseClick(&o, Qt::MiddleButton, Qt::NoModifier, {400, 300});
    if (gesture == "enter" || gesture == "source")
      QTest::keyClick(&o, Qt::Key_Return,
                      gesture == "source" ? Qt::ControlModifier
                                          : Qt::NoModifier);
    QCOMPARE(action, expected);
    QCOMPARE(exported, expectedImage);
    QCOMPARE(o.selection, QRect(100, 100, 400, 300));
  }
  void selectionPrecisionAndSpace() {
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {100, 100});
    QTest::mouseMove(&o, {300, 250});
    QTest::keyPress(&o, Qt::Key_Space);
    QTest::mouseMove(&o, {320, 270});
    QTest::keyRelease(&o, Qt::Key_Space);
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {320, 270});
    QCOMPARE(o.selection, QRect(120, 120, 200, 150));
    QTest::keyClick(&o, Qt::Key_Left, Qt::ControlModifier);
    QCOMPARE(o.selection, QRect(119, 120, 201, 150));
    QTest::keyClick(&o, Qt::Key_Left, Qt::ShiftModifier);
    QCOMPARE(o.selection, QRect(120, 120, 200, 150));
    QTest::keyClick(&o, Qt::Key_Up, Qt::ControlModifier);
    QCOMPARE(o.selection, QRect(120, 119, 200, 151));
    QTest::keyClick(&o, Qt::Key_Down, Qt::ShiftModifier);
    QCOMPARE(o.selection, QRect(120, 119, 200, 150));
    o.resize(640, 480);
    QTest::keyClick(&o, Qt::Key_Right);
    QCOMPARE(o.selection.x(), 121);
    o.recalledSelection = {11, 22, 120, 80};
    QTest::keyClick(&o, Qt::Key_R);
    QCOMPARE(o.selection, o.recalledSelection);
  }
  void currentObjectParametersAndHistory() {
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selectAll();
    o.annotations->choose("rectangle");
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {120, 160});
    QMouseEvent move(QEvent::MouseMove, QPointF(260, 230),
                     o.mapToGlobal(QPoint(260, 230)), Qt::NoButton,
                     Qt::LeftButton, Qt::ShiftModifier);
    QApplication::sendEvent(&o, &move);
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {260, 230});
    QCOMPARE(o.document.strokes.last().points.last(), QPointF(260, 300));
    QVERIFY(o.annotations->hasCurrent());
    auto small = o.document.render();
    auto size = o.findChild<QSpinBox *>("annotationSize");
    size->setValue(14);
    QVERIFY(o.document.render() != small);
    auto color = o.findChild<QComboBox *>("annotationColor");
    color->setCurrentIndex(1);
    QCOMPARE(o.document.render().pixelColor(120, 210), QColor("#e13c39"));
    auto colored = o.document.render();
    // Drag the actual outline. Empty space inside the box starts a new shape.
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {120, 210});
    QTest::mouseMove(&o, {140, 230});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {140, 230});
    QCOMPARE(o.document.strokes.size(), 1);
    QVERIFY(o.document.render() != colored);
    QTest::mouseClick(&o, Qt::RightButton, Qt::NoModifier, {450, 400});
    auto complete = o.document.render();
    QVERIFY(!o.annotations->hasCurrent());
    QVERIFY(complete != base);
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(o.document.render(), base);
    QTest::keyClick(&o, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(o.document.render(), complete);
    QVERIFY(o.annotations->hasCurrent());
    size->setValue(2);
    QVERIFY(o.document.render() != complete);
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier | Qt::ShiftModifier);
    QCOMPARE(o.document.render(), base);
    QVERIFY(o.document.redoStack.isEmpty());
    QTest::mousePress(&o, Qt::LeftButton, Qt::NoModifier, {400, 200});
    QTest::mouseMove(&o, {500, 300});
    QTest::mouseRelease(&o, Qt::LeftButton, Qt::NoModifier, {500, 300});
    QVERIFY(o.document.render() != base);
  }
  void textDraftParametersAndReopen() {
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    CaptureOverlay o(QGuiApplication::primaryScreen(), base, "global");
    o.setAttribute(Qt::WA_DeleteOnClose, false);
    o.resize(800, 600);
    o.show();
    o.selectAll();
    o.annotations->choose("text");
    QTest::mouseClick(&o, Qt::LeftButton, Qt::NoModifier, {160, 180});
    auto text = o.annotations->textWidget();
    QVERIFY(text);
    QInputMethodEvent commit;
    commit.setCommitString(QStringLiteral("中文第一行\n第二行"));
    QApplication::sendEvent(text, &commit);
    o.findChild<QSpinBox *>("annotationSize")->setValue(32);
    QVERIFY(o.annotations->typing());
    QCOMPARE(text->toPlainText(), QStringLiteral("中文第一行\n第二行"));
    QTest::keyClick(text, Qt::Key_Return, Qt::ControlModifier);
    QVERIFY(!o.annotations->typing());
    QVERIFY(o.annotations->hasCurrent());
    auto before = o.document.render();
    o.findChild<QSpinBox *>("annotationRotation")->setValue(25);
    QVERIFY(o.document.render() != before);
    QTest::mouseDClick(&o, Qt::LeftButton, Qt::NoModifier, {190, 210});
    QVERIFY(o.annotations->typing());
    QTest::mouseClick(&o, Qt::RightButton, Qt::NoModifier, {600, 400});
    QVERIFY(!o.annotations->typing());
    QVERIFY(!o.annotations->hasCurrent());
    QCOMPARE(o.document.strokes.last().text,
             QStringLiteral("中文第一行\n第二行"));
    QVERIFY(o.document.render() != base);
    QTest::keyClick(&o, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(o.document.render(), base);
  }
  void pinTransformsEditingAndDisplay() {
    QImage base(300, 220, QImage::Format_RGB32);
    base.fill(Qt::white);
    {
      QPainter p(&base);
      p.fillRect(0, 0, 60, 40, Qt::red);
    }
    PinWindow p(base);
    p.setAttribute(Qt::WA_DeleteOnClose, false);
    p.show();
    auto originalSize = p.size();
    QTest::keyClick(&p, Qt::Key_Plus);
    QVERIFY(p.width() > originalSize.width());
    QTest::keyClick(&p, Qt::Key_Minus, Qt::ControlModifier);
    QVERIFY(p.windowOpacity() < 1);
    QCOMPARE(p.exportImage(), base);
    QTest::mouseClick(&p, Qt::MiddleButton);
    QCOMPARE(p.size(), originalSize);
    QCOMPARE(p.windowOpacity(), 1.0);
    QTest::keyClick(&p, Qt::Key_2);
    QTransform rotation;
    rotation.rotate(-90);
    QCOMPARE(p.exportImage(), base.transformed(rotation));
    QTest::keyClick(&p, Qt::Key_3);
    auto expected = base.transformed(rotation)
                        .mirrored(true, false)
                        .convertToFormat(QImage::Format_ARGB32);
    QCOMPARE(p.exportImage().convertToFormat(QImage::Format_ARGB32), expected);
    QTest::keyClick(&p, Qt::Key_Space);
    QVERIFY(p.isEditing());
    p.annotations->choose("line");
    auto a = p.annotations->displayTransform().map(QPointF(100, 80)).toPoint(),
         b = p.annotations->displayTransform().map(QPointF(200, 160)).toPoint();
    QTest::mousePress(&p, Qt::LeftButton, Qt::NoModifier, a);
    QTest::mouseMove(&p, b);
    QTest::mouseRelease(&p, Qt::LeftButton, Qt::NoModifier, b);
    QVERIFY(p.exportImage().convertToFormat(QImage::Format_ARGB32) != expected);
    auto marked = p.exportImage();
    QTest::keyClick(&p, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(p.exportImage().convertToFormat(QImage::Format_ARGB32), expected);
    QTest::keyClick(&p, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(p.exportImage(), marked);
    p.setEditing(false);
    auto size = p.size();
    QTest::mouseDClick(&p, Qt::LeftButton, Qt::ShiftModifier);
    QVERIFY(p.size() != size);
    QTest::mouseDClick(&p, Qt::LeftButton, Qt::ShiftModifier);
    QCOMPARE(p.size(), size);
    QCOMPARE(p.exportImage(), marked);
    p.close();
  }
  void pinDocumentHandoffAndRecovery() {
    QTemporaryDir root;
    CaptureEngine engine("ux-" + QUuid::createUuid().toString(), "token",
                         root.path());
    engine.authenticated = true;
    QImage base(800, 600, QImage::Format_RGB32);
    base.fill(Qt::white);
    auto o =
        new CaptureOverlay(QGuiApplication::primaryScreen(), base, "global");
    o->selection = {100, 100, 300, 200};
    o->document.append({"arrow", {{120, 120}, {260, 240}}, Qt::red, 5});
    auto expected = o->document.render().copy(o->selection);
    const auto expectedGeometry = o->selectionGeometry();
    engine.session = "synthetic";
    engine.selected = o;
    engine.overlays << o;
    engine.output(o, "pin", expected);
    QCOMPARE(engine.pins.size(), 1);
    auto pin = engine.pins.first();
    QCOMPARE(pin->geometry(), expectedGeometry);
    QCOMPARE(pin->exportImage(), expected);
    QVERIFY(!pin->document.strokes.isEmpty());
    pin->setEditing(true);
    QTest::keyClick(pin, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(pin->exportImage(), base.copy(100, 100, 300, 200));
    QTest::keyClick(pin, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(pin->exportImage(), expected);
    pin->setEditing(false);
    QTest::keyClick(pin, Qt::Key_Plus);
    pin->setWindowOpacity(0.5);
    auto state = pin->viewState();
    engine.receive({{"type", "togglePins"}});
    QVERIFY(!pin->isVisible());
    engine.receive({{"type", "togglePins"}});
    QVERIFY(pin->isVisible());
    pin->close();
    QTRY_VERIFY(engine.pins.isEmpty());
    QVERIFY(engine.closedPin.has_value());
    engine.receive({{"type", "restorePin"}});
    QCOMPARE(engine.pins.size(), 1);
    pin = engine.pins.first();
    QCOMPARE(pin->exportImage(), expected);
    QCOMPARE(pin->geometry(), state.geometry);
    QCOMPARE(pin->windowOpacity(), state.opacity);
    QVERIFY(!engine.closedPin);
    QTest::keyClick(pin, Qt::Key_Escape, Qt::ShiftModifier);
    QTRY_VERIFY(engine.pins.isEmpty());
    QVERIFY(!engine.closedPin);
    QString error;
    for (int i = 0; i < 10; ++i)
      QVERIFY(engine.pin(base.copy(0, 0, 8, 8), &error));
    engine.pins.first()->close();
    QTRY_COMPARE(engine.pins.size(), 9);
    QVERIFY(!engine.pin(base.copy(0, 0, 8, 8), &error));
    engine.receive({{"type", "restorePin"}});
    QCOMPARE(engine.pins.size(), 10);
  }
  void quickSaveAndCancellation() {
    QTemporaryDir root;
    QWidget owner;
    owner.show();
    QImage base(30, 40, QImage::Format_RGB32);
    base.fill(Qt::red);
    QString error;
    auto prefs = root.filePath("capture.ini");
    QTimer::singleShot(30, [] {
      for (auto w : QApplication::topLevelWidgets())
        if (auto d = qobject_cast<QFileDialog *>(w))
          d->reject();
    });
    QVERIFY(!Capture::saveWithDialog(&owner, base, true, prefs, &error));
    QVERIFY(error.isEmpty());
    QVERIFY(QDir(root.path()).entryList({"*.png"}, QDir::Files).isEmpty());
    {
      QSettings settings(prefs, QSettings::IniFormat);
      settings.setValue("quickSaveDirectory", root.path());
    }
    QVERIFY(Capture::saveWithDialog(&owner, base, true, prefs, &error));
    auto files = QDir(root.path()).entryList({"*.png"}, QDir::Files);
    QCOMPARE(files.size(), 1);
    QCOMPARE(QImage(root.filePath(files.first())), base);
    {
      QSettings settings(prefs, QSettings::IniFormat);
      settings.setValue("quickSaveDirectory", root.filePath("missing"));
    }
    QVERIFY(!Capture::saveWithDialog(&owner, base, true, prefs, &error));
    QVERIFY(!error.isEmpty());
    QCOMPARE(base.pixelColor(0, 0), QColor(Qt::red));
  }
  void interruptedAnnotation_data() {
    QTest::addColumn<QString>("tool");
    QTest::addColumn<QString>("action");
    for (auto tool : QStringList{QStringLiteral("矩形"), QStringLiteral("椭圆"),
                                 QStringLiteral("箭头"), QStringLiteral("画笔"),
                                 QStringLiteral("马赛克")})
      for (auto action :
           QStringList{"escape", "right-click", "undo", "full-screen"})
        QTest::newRow(qPrintable(tool + "/" + action)) << tool << action;
  }
  void interruptedAnnotation() {
    QFETCH(QString, tool);
    QFETCH(QString, action);
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "global");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    overlay.selectAll();
    int cancellations = 0;
    overlay.cancel = [&] { ++cancellations; };
    auto toolbar = overlay.findChild<QToolBar *>();
    auto actions = overlay.annotations->panel->findChildren<QAction *>();
    auto chosen = std::find_if(actions.begin(), actions.end(),
                               [&](auto a) { return a->text() == tool; });
    QVERIFY(chosen != actions.end());
    (*chosen)->trigger();
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {120, 160});
    QTest::mouseMove(&overlay, {200, 200});
    if (action == "escape")
      QTest::keyClick(&overlay, Qt::Key_Escape);
    else if (action == "right-click") {
      QTest::mousePress(&overlay, Qt::RightButton, Qt::NoModifier, {200, 200});
      QTest::mouseRelease(&overlay, Qt::RightButton, Qt::NoModifier,
                          {200, 200});
    } else if (action == "undo")
      QTest::keyClick(&overlay, Qt::Key_Z, Qt::ControlModifier);
    else
      QTest::keyClick(&overlay, Qt::Key_F);
    // Still holding left: cancellation/commit must not resume the old stroke.
    const auto completed = overlay.document.render();
    QTest::mouseMove(&overlay, {320, 260});
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {320, 260});
    QCOMPARE(cancellations, 0);
    QCOMPARE(overlay.document.render(), completed);
    const auto expected =
        action == "full-screen" || action == "right-click" ? 1 : 0;
    QCOMPARE(overlay.document.strokes.size(), expected);
    // The tool remains usable for a new gesture.
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {150, 180});
    QTest::mouseMove(&overlay, {250, 280});
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {250, 280});
    QCOMPARE(overlay.document.strokes.size(), expected + 1);
    QCOMPARE(overlay.document.strokes.last().tool,
             tool == QStringLiteral("矩形")   ? QString("rectangle")
             : tool == QStringLiteral("椭圆") ? QString("ellipse")
             : tool == QStringLiteral("箭头") ? QString("arrow")
             : tool == QStringLiteral("画笔") ? QString("pen")
                                              : QString("mosaic"));
  }
  void systemCloseCleansUpAllOverlays() {
    QTemporaryDir root;
    CaptureEngine engine("close-" + QUuid::createUuid().toString(), "token",
                         root.path());
    auto cleanup = qScopeGuard([&] {
      engine.finish("cancelled");
      for (auto pin : engine.pins)
        if (pin)
          pin->close();
      QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    });
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    engine.session = QUuid::createUuid().toString(QUuid::WithoutBraces);
    engine.delivery = "pending-output";
    engine.busy = true;
    QVector<QPointer<CaptureOverlay>> windows;
    for (int i = 0; i < 2; ++i) {
      auto overlay =
          new CaptureOverlay(QGuiApplication::primaryScreen(), image, "global");
      overlay->cancel = [&] { engine.finish("cancelled"); };
      overlay->resize(800, 600);
      overlay->show();
      engine.overlays.push_back(overlay);
      windows.push_back(overlay);
    }
    engine.selected = windows.first();
    QString error;
    QVERIFY(engine.pin(image.copy(0, 0, 20, 30), &error));
    QPointer<PinWindow> pin = engine.pins.first();
    SendMessageW(reinterpret_cast<HWND>(windows.first()->winId()),
                 WM_SYSCOMMAND, SC_CLOSE, 0);
    QTRY_VERIFY(engine.session.isEmpty());
    QVERIFY(engine.delivery.isEmpty());
    QVERIFY(!engine.busy);
    QVERIFY(engine.selected.isNull());
    QVERIFY(engine.overlays.isEmpty());
    for (auto window : windows)
      QTRY_VERIFY(window.isNull());
    QVERIFY(pin && pin->isVisible());
    QCOMPARE(engine.pins.size(), 1);
    pin->close();
    QTRY_VERIFY(pin.isNull());
  }
  void selectionAndExport() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "note");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    overlay.claim = [](auto *) { return true; };
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {500, 400});
    QTest::mouseMove(&overlay, {100, 100});
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {100, 100});
    QCOMPARE(overlay.selection, QRect(100, 100, 400, 300));
    QTest::keyClick(&overlay, Qt::Key_Right);
    QCOMPARE(overlay.selection.x(), 101);
    QTest::keyClick(&overlay, Qt::Key_Down, Qt::ShiftModifier);
    QCOMPARE(overlay.selection.height(), 299);
    Capture::Stroke arrow{"arrow", {{150, 150}, {250, 250}}, Qt::red, 4};
    overlay.document.append(arrow);
    QImage output;
    QString action;
    overlay.output = [&](QString a, QImage i) {
      action = a;
      output = i;
    };
    QTest::keyClick(&overlay, Qt::Key_C, Qt::ControlModifier);
    QCOMPARE(action, QString("copy"));
    QCOMPARE(output.size(), overlay.selection.size());
    QCOMPARE(output, overlay.document.render().copy(overlay.selection));
    action.clear();
    output = QImage();
    QTest::mouseDClick(&overlay, Qt::LeftButton, Qt::NoModifier, {400, 300});
    // This fixture originated from a note: ordinary completion returns to that form.
    // Ctrl+C above independently keeps its explicit copy action and pixel assertions.
    QCOMPARE(action, QString("source"));
    QCOMPARE(output, overlay.document.render().copy(overlay.selection));
    QCOMPARE(overlay.selection, QRect(101, 100, 400, 299));
    QTest::keyClick(&overlay, Qt::Key_A, Qt::ControlModifier);
    QCOMPARE(overlay.selection, image.rect());
    auto toolbar = overlay.annotations->outputs;
    QVERIFY(overlay.rect().contains(overlay.annotations->panel->geometry()));
    QVERIFY(overlay.grab().save(QCoreApplication::applicationDirPath() +
                                "/../capture-toolbar-preview.png"));
    overlay.resize(240, 600);
    overlay.selectAll();
    QTest::qWait(20);
    QVERIFY(overlay.rect().contains(overlay.annotations->panel->geometry()));
    for (auto id : {"pin", "save", "cancel", "source"}) {
      auto action = overlay.annotations->action(id);
      QVERIFY(action);
      auto button = toolbar->widgetForAction(action);
      QVERIFY(button);
      QVERIFY2(button->isVisible(),
               qPrintable(QString("Output button hidden: id=%1 hidden=%2 "
                                  "toolbarVisible=%3 panelVisible=%4 "
                                  "button=(%5,%6 %7x%8) toolbar=%9x%10 panel=%11x%12")
                              .arg(id)
                              .arg(button->isHidden())
                              .arg(toolbar->isVisible())
                              .arg(overlay.annotations->panel->isVisible())
                              .arg(button->x()).arg(button->y())
                              .arg(button->width()).arg(button->height())
                              .arg(toolbar->width()).arg(toolbar->height())
                              .arg(overlay.annotations->panel->width())
                              .arg(overlay.annotations->panel->height())));
    }
    // Form captures keep their return action visible and copy in More.
    auto copyAction = overlay.annotations->action("copy");
    QVERIFY(copyAction);
    QVERIFY(!toolbar->actions().contains(copyAction));
    auto moreButton = toolbar->findChild<QToolButton *>("captureMore");
    QVERIFY(moreButton);
    QVERIFY(moreButton->isVisible());
    QVERIFY(moreButton->menu());
    QVERIFY(moreButton->menu()->actions().contains(copyAction));
    QVERIFY(copyAction->isVisible());
    QVERIFY(copyAction->isEnabled());
    overlay.close();
  }
  void copyOnSelectSkipsEditorAndAllowsRetry() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::red);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "global",
                           {}, {}, true);
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    int copied = 0, cancelled = 0;
    QImage exported;
    overlay.cancel = [&] { ++cancelled; };
    overlay.output = [&](QString action, QImage pixels) {
      QCOMPARE(action, QString("copy"));
      exported = pixels;
      ++copied;
      if (copied == 1)
        overlay.showError(QStringLiteral("测试剪贴板占用，可按 Enter 重试"));
    };
    QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {120, 160});
    QTest::mouseMove(&overlay, {320, 260});
    QCOMPARE(copied, 0);
    QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {320, 260});
    QCOMPARE(copied, 1);
    QCOMPARE(exported, image.copy(overlay.selection));
    QVERIFY(!overlay.annotations->panel->isVisible());
    QVERIFY(overlay.document.strokes.isEmpty());
    const auto selected = overlay.selection;
    QTest::keyClick(&overlay, Qt::Key_Return);
    QCOMPARE(copied, 2);
    QCOMPARE(overlay.selection, selected);
    QTest::keyClick(&overlay, Qt::Key_C, Qt::ControlModifier);
    QCOMPARE(copied, 3);
    QTest::keyClick(&overlay, Qt::Key_S, Qt::ControlModifier);
    QCOMPARE(copied, 3);
    QTest::keyClick(&overlay, Qt::Key_Escape);
    QCOMPARE(cancelled, 1);
  }
  void resizeHandles() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "note");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    const QVector<QPoint> points = {{100, 100}, {200, 100}, {300, 100},
                                    {300, 150}, {300, 200}, {200, 200},
                                    {100, 200}, {100, 150}};
    const QVector<QRect> expected = {
        {110, 110, 190, 90},  {100, 110, 200, 90},  {100, 110, 210, 90},
        {100, 100, 210, 100}, {100, 100, 210, 110}, {100, 100, 200, 110},
        {110, 100, 190, 110}, {110, 100, 190, 100}};
    for (int i = 0; i < points.size(); ++i) {
      overlay.selection = {100, 100, 200, 100};
      QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, points[i]);
      QTest::mouseMove(&overlay, points[i] + QPoint(10, 10));
      QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier,
                          points[i] + QPoint(10, 10));
      QCOMPARE(overlay.selection, expected[i]);
    }
    overlay.close();
  }
  void captureOverlayMemoryTracksSharedAndRenderedPixels() {
    QImage image(160, 120, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "global");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    const auto imageBytes = image.sizeInBytes();
    QCOMPARE(overlay.memoryCost(), overlay.document.memoryCost());

    overlay.document.append({"line", {{20, 20}, {80, 80}}, Qt::red, 3});
    overlay.annotations->sync();
    overlay.annotations->changed();
    QCOMPARE(overlay.memoryCost(),
             overlay.document.memoryCost() + imageBytes);
    overlay.annotations->action("undo")->trigger();
    QVERIFY(overlay.document.strokes.isEmpty());
    QVERIFY(!overlay.document.redoStack.isEmpty());
    QCOMPARE(overlay.memoryCost(), overlay.document.memoryCost());
    overlay.annotations->action("redo")->trigger();
    QCOMPARE(overlay.memoryCost(),
             overlay.document.memoryCost() + imageBytes);
    overlay.annotations->action("clear")->trigger();
    QCOMPARE(overlay.memoryCost(), imageBytes);
  }
  void captureOverlayAllocationIncludesExistingComposite() {
    QTemporaryDir root;
    CaptureEngine engine("overlay-budget-" + QUuid::createUuid().toString(),
                         "token", root.path());
    engine.capture({{"sessionId", QUuid::createUuid().toString(QUuid::WithoutBraces)},
                    {"origin", "global"}});
    QVERIFY(!engine.session.isEmpty());
    QCOMPARE(engine.overlays.size(), 1);
    const auto overlay = engine.overlays.first();
    QVERIFY(overlay);
    overlay->hide();
    // Reserve the remaining allowance without allocating a large collection
    // of pins. This is an image-resource budget, not a process RSS assertion.
    QVERIFY(overlay->annotations->allowAllocation(
        Capture::MaxTotalBytes - overlay->document.memoryCost()));
    overlay->document.append({"line", {{2, 2}, {12, 12}}, Qt::red, 3});
    overlay->annotations->sync();
    overlay->annotations->changed();
    QVERIFY(!overlay->annotations->allowAllocation(
        Capture::MaxTotalBytes - overlay->document.memoryCost()));
    QVERIFY(overlay->annotations->allowAllocation(
        Capture::MaxTotalBytes - overlay->memoryCost()));
    QVERIFY(!overlay->annotations->allowAllocation(
        Capture::MaxTotalBytes - overlay->memoryCost() + 1));
    overlay->annotations->action("undo")->trigger();
    QVERIFY(overlay->annotations->allowAllocation(
        Capture::MaxTotalBytes - overlay->document.memoryCost()));
    engine.finish("cancelled");
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
  }
  void pinLimitsAndOriginalPixels() {
    QTemporaryDir root;
    CaptureEngine engine("limit-" + QUuid::createUuid().toString(), "token",
                         root.path());
    QString error;
    QImage small(20, 30, QImage::Format_ARGB32);
    small.fill(Qt::red);
    for (int i = 0; i < 10; ++i)
      QVERIFY(engine.pin(small, &error));
    QVERIFY(!engine.pin(small, &error));
    QCOMPARE(engine.pins.size(), 10);
    auto first = engine.pins.first();
    first->resize(100, 150);
    first->setWindowOpacity(0.3);
    QCOMPARE(first->image, small);
    for (auto p : engine.pins)
      p->destroyPin();
    QTRY_VERIFY(engine.pins.isEmpty());
    // Shared immutable backing keeps this budget test from allocating 640 MiB.
    QImage large(8192, 4096, QImage::Format_ARGB32);
    large.fill(Qt::white);
    QVERIFY(engine.pin(large, &error));
    QApplication::processEvents();
    // Native halo bitmaps now count toward the total. A headless run has no
    // such surfaces; on a visible desktop they can consume the last few bytes
    // that previously allowed four images at exactly 128 MiB each.
    const auto capacity =
        Capture::MaxTotalBytes / engine.pins.first()->memoryCost();
    QVERIFY(capacity >= 3 && capacity <= 4);
    for (qint64 i = 1; i < capacity; ++i) {
      QVERIFY(engine.pin(large, &error));
      QApplication::processEvents();
    }
    QVERIFY(!engine.pin(large, &error));
    for (auto p : engine.pins)
      p->destroyPin();
    QTRY_VERIFY(engine.pins.isEmpty());
    QVERIFY(engine.pin(small, &error));
    engine.pins.first()->close();
    QTRY_VERIFY(engine.pins.isEmpty());
  }
  void saveDialogCancellation() {
    QTemporaryDir root;
    CaptureEngine engine("dialog-" + QUuid::createUuid().toString(), "token",
                         root.path());
    QImage image(20, 30, QImage::Format_RGB32);
    image.fill(Qt::white);
    auto overlay =
        new CaptureOverlay(QGuiApplication::primaryScreen(), image, "global");
    engine.overlays.push_back(overlay);
    engine.selected = overlay;
    engine.session = "test";
    QTimer::singleShot(30, [] {
      for (auto w : QApplication::topLevelWidgets())
        if (auto dialog = qobject_cast<QFileDialog *>(w))
          dialog->reject();
    });
    engine.output(overlay, "save", image);
    QCOMPARE(engine.session, QString("test"));
    QVERIFY(!engine.busy);
    overlay->selection = {0, 0, 20, 30};
    overlay->document.append({"line", {{2, 3}, {15, 23}}, Qt::red, 3});
    auto content = overlay->document.render();
    engine.settingsPath = root.filePath("capture.ini");
    {
      QSettings settings(engine.settingsPath, QSettings::IniFormat);
      settings.setValue("quickSaveDirectory", root.filePath("missing"));
    }
    engine.output(overlay, "quickSave", content);
    QCOMPARE(engine.session, QString("test"));
    QVERIFY(!engine.busy);
    QCOMPARE(overlay->document.render(), content);
    QCOMPARE(overlay->selection, QRect(0, 0, 20, 30));
    QPointer<CaptureOverlay> guard(overlay);
    QTimer::singleShot(30, [&] { engine.finish("cancelled"); });
    engine.output(overlay, "save", image);
    QTRY_VERIFY(guard.isNull());
    QVERIFY(engine.session.isEmpty());
    QVERIFY(!engine.busy);
  }
  void annotationToolsAndChineseInput() {
    QImage image(800, 600, QImage::Format_RGB32);
    image.fill(Qt::white);
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), image, "note");
    overlay.setAttribute(Qt::WA_DeleteOnClose, false);
    overlay.resize(800, 600);
    overlay.show();
    overlay.selectAll();
    auto toolbar = overlay.findChild<QToolBar *>();
    auto choose = [&](QString name) {
      for (auto a : overlay.annotations->panel->findChildren<QAction *>())
        if (a->text() == name) {
          a->trigger();
          return true;
        }
      return false;
    };
    for (auto name : QStringList{QStringLiteral("矩形"), QStringLiteral("椭圆"),
                                 QStringLiteral("箭头"), QStringLiteral("画笔"),
                                 QStringLiteral("马赛克")}) {
      QVERIFY(choose(name));
      auto count = overlay.document.strokes.size();
      QTest::mousePress(&overlay, Qt::LeftButton, Qt::NoModifier, {120, 160});
      QTest::mouseMove(&overlay, {320, 260});
      QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::NoModifier, {320, 260});
      QCOMPARE(overlay.document.strokes.size(), count + 1);
    }
    QVERIFY(choose(QStringLiteral("文字")));
    QTest::mouseClick(&overlay, Qt::LeftButton, Qt::NoModifier, {200, 300});
    auto editor = overlay.annotations->textWidget();
    QVERIFY(editor);
    QInputMethodEvent commit;
    commit.setCommitString(QStringLiteral("中文标注\n第二行"));
    QApplication::sendEvent(editor, &commit);
    QTest::keyClick(editor, Qt::Key_Return, Qt::ControlModifier);
    QCOMPARE(overlay.document.strokes.last().text,
             QStringLiteral("中文标注\n第二行"));
    auto completed = overlay.document.render();
    QTest::keyClick(&overlay, Qt::Key_Z, Qt::ControlModifier);
    QVERIFY(overlay.document.render() != completed);
    QTest::keyClick(&overlay, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(overlay.document.render(), completed);
    // A smaller logical viewport still edits canonical physical-image pixels.
    overlay.resize(640, 480);
    overlay.annotations->complete();
    overlay.selection = QRect(100, 100, 200, 100);
    QTest::keyClick(&overlay, Qt::Key_Right);
    QCOMPARE(overlay.selection.x(), 101);
    overlay.close();
  }
  void displayChangeCancelsSessionAndRecoversPin() {
    QTemporaryDir root;
    CaptureEngine engine("topology-" + QUuid::createUuid().toString(), "token",
                         root.path());
    QImage image(100, 80, QImage::Format_RGB32);
    image.fill(Qt::white);
    QString error;
    QVERIFY(engine.pin(image, &error));
    QPointer<PinWindow> pin = engine.pins.first();
    const auto work = Capture::nativeWorkArea(QGuiApplication::primaryScreen());
    QVERIFY(pin->placeAtPhysicalGeometry(
        QRect(work.bottomRight() + QPoint(1000, 1000), QSize(100, 80))));
    auto overlay =
        new CaptureOverlay(QGuiApplication::primaryScreen(), image, "global");
    engine.overlays << overlay;
    engine.selected = overlay;
    engine.session = "topology-session";
    engine.lastArea = {10, 20, 50, 30};
    engine.lastScreen = "old-layout";
    overlay->cancel = [&] { engine.finish("cancelled"); };
    QPointer<CaptureOverlay> guard = overlay;
    auto screen = QGuiApplication::primaryScreen();
    // Simulate the Qt notification, without changing the user's display setup.
    QVERIFY(QMetaObject::invokeMethod(screen, "geometryChanged",
                                      Qt::DirectConnection,
                                      Q_ARG(QRect, screen->geometry())));
    QVERIFY(engine.session.isEmpty());
    QVERIFY(engine.lastArea.isEmpty());
    QVERIFY(engine.lastScreen.isEmpty());
    QTRY_VERIFY(guard.isNull());
    QVERIFY(pin && pin->isVisible());
    QVERIFY(Capture::nativeWorkArea(screen).contains(
        Capture::physicalWindowRect(pin->winId())));
  }
  void realDesktopSessionAndPins() {
    if (!Capture::interactiveDesktopAvailable())
      QSKIP("Windows session is locked; real desktop capture requires an "
            "unlocked session");
    // Every monitor is covered by test-owned pixels before freezing the
    // desktop.
    QVector<QWidget *> canvases;
    for (auto screen : QGuiApplication::screens()) {
      auto canvas = new QWidget(nullptr, Qt::FramelessWindowHint |
                                             Qt::WindowStaysOnTopHint);
      canvas->setScreen(screen);
      canvas->setGeometry(screen->geometry());
      canvas->setStyleSheet("background:#245080;");
      canvas->show();
      canvas->raise();
      canvases << canvas;
    }
    auto canvasCleanup = qScopeGuard([&] { qDeleteAll(canvases); });
    QTest::qWait(200);
    QTemporaryDir root;
    auto name =
        "capture-test-" + QUuid::createUuid().toString(QUuid::WithoutBraces);
    QString token(64, 'a');
    CaptureEngine engine(name, token, root.path());
    QLocalSocket socket;
    socket.connectToServer(name);
    QTRY_COMPARE(socket.state(), QLocalSocket::ConnectedState);
    auto send = [&](QJsonObject m) {
      socket.write(QJsonDocument(m).toJson(QJsonDocument::Compact) + '\n');
      socket.flush();
    };
    QByteArray incoming;
    QList<QJsonObject> messages;
    connect(&socket, &QLocalSocket::readyRead, this, [&] {
      incoming += socket.readAll();
      while (incoming.contains('\n')) {
        int e = incoming.indexOf('\n');
        qInfo().noquote() << incoming.left(e);
        messages.append(QJsonDocument::fromJson(incoming.left(e)).object());
        incoming.remove(0, e + 1);
      }
    });
    auto has = [&](QString type) {
      return std::any_of(messages.begin(), messages.end(),
                         [&](auto m) { return m["type"].toString() == type; });
    };
    send({{"type", "hello"}, {"version", 1}, {"token", token}});
    QTRY_VERIFY(has("ready"));
    auto id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    QDir(root.path()).mkdir(id);
    send({{"type", "capture"}, {"origin", "note"}, {"sessionId", id}});
    QTRY_VERIFY_WITH_TIMEOUT(has("captureReady"), 10000);
    CaptureOverlay *overlay = nullptr;
    for (auto w : QApplication::topLevelWidgets())
      if (auto o = qobject_cast<CaptureOverlay *>(w))
        overlay = o;
    QVERIFY(overlay);
    overlay->selectAll();
    QImage frozen = overlay->document.base;
    overlay->document.append({"arrow", {{120, 140}, {300, 260}}, Qt::red, 5});
    const auto annotated = overlay->document.render();
    QTest::qWait(100);
    QCOMPARE(overlay->document.base, frozen);
    overlay->output("source", frozen.copy(QRect(0, 0, 20, 30)));
    QTRY_VERIFY(has("output"));
    QJsonObject delivery;
    for (auto m : messages)
      if (m["type"] == "output")
        delivery = m;
    QString assetPath =
        QDir(root.path())
            .filePath(id + "/" + delivery["deliveryId"].toString() + ".png");
    QCOMPARE(QImage(assetPath).size(), QSize(20, 30));
    QVERIFY(!overlay->isVisible());
    send({{"type", "ack"},
          {"sessionId", id},
          {"deliveryId", delivery["deliveryId"]},
          {"accepted", false},
          {"message", "test rejection"}});
    QTRY_VERIFY(overlay->isVisible());
    QCOMPARE(overlay->document.base, frozen);
    QVERIFY(!QFile::exists(assetPath));
    QCOMPARE(overlay->document.render(), annotated);
    QTest::keyClick(overlay, Qt::Key_T, Qt::ControlModifier);
    QTRY_VERIFY(has("finished"));
    QCOMPARE(std::count_if(messages.begin(), messages.end(),
                           [](auto m) { return m["type"] == "finished"; }),
             1);
    QCOMPARE(messages.last()["status"].toString(), QString("pinned"));
    PinWindow *pin = nullptr;
    for (auto w : QApplication::topLevelWidgets())
      if (auto p = qobject_cast<PinWindow *>(w))
        pin = p;
    QVERIFY(pin);
    QCOMPARE(pin->image, frozen);
    QCOMPARE(pin->exportImage(), annotated);
    QVERIFY(pin->isVisible());
    auto position = pin->pos();
    send({{"type", "togglePins"}});
    QTRY_VERIFY(!pin->isVisible());
    send({{"type", "togglePins"}});
    QTRY_VERIFY(pin->isVisible());
    QCOMPARE(pin->pos(), position);
    // Exercise the actual capture wiring over IPC, including another capture
    // after a system close. Existing pins must survive both cancellations.
    for (bool systemClose : {true, false}) {
      messages.clear();
      auto nextId = QUuid::createUuid().toString(QUuid::WithoutBraces);
      send({{"type", "capture"}, {"origin", "global"}, {"sessionId", nextId}});
      QTRY_VERIFY_WITH_TIMEOUT(has("captureReady"), 10000);
      QVERIFY(!engine.overlays.isEmpty());
      QPointer<CaptureOverlay> current = engine.overlays.first();
      QVERIFY(current);
      current->selectAll();
      if (systemClose)
        SendMessageW(reinterpret_cast<HWND>(current->winId()), WM_SYSCOMMAND,
                     SC_CLOSE, 0);
      else
        QTest::keyClick(current, Qt::Key_Escape);
      QTRY_VERIFY(has("finished"));
      QTRY_VERIFY(current.isNull());
      QVERIFY(engine.session.isEmpty());
      QCOMPARE(std::count_if(messages.begin(), messages.end(),
                             [](auto m) { return m["type"] == "finished"; }),
               1);
      QCOMPARE(messages.last()["sessionId"].toString(), nextId);
      QCOMPARE(messages.last()["status"].toString(), QString("cancelled"));
      QVERIFY(pin->isVisible());
    }
    QPointer<PinWindow> guard = pin;
    QTest::keyClick(pin, Qt::Key_Escape);
    QTRY_VERIFY(guard.isNull());
    socket.disconnectFromServer();
  }
};
int main(int argc, char **argv) {
  if (argc > 1 && std::strcmp(argv[1], "--isolated-feedback-copy") == 0) {
    const auto reportDirectory =
        qEnvironmentVariable("ABANDON_CAPTURE_FEEDBACK_REPORT_DIRECTORY");
    const auto token =
        qEnvironmentVariable("ABANDON_CAPTURE_FEEDBACK_RUN_TOKEN");
    if (argc != 2 || QUuid::fromString(token).isNull() ||
        reportDirectory.isEmpty() || !QDir(reportDirectory).exists() ||
        !QDir::setCurrent(reportDirectory))
      return 2;
    FeedbackClipboardDesktop desktop;
    const bool ready = desktop.open();
    const auto binding = desktop.evidence();
    const auto isolationError = binding["failureWin32Error"].toInteger();
    int result = 2;
    if (ready) {
      isolatedStationName = binding["station"].toString();
      isolatedDesktopName = binding["desktop"].toString();
      isolatedFeedbackCopy = true;
      QApplication::setAttribute(Qt::AA_DontUseNativeDialogs);
      {
        QApplication app(argc, argv);
        app.setStyle("Fusion");
        app.setQuitOnLastWindowClosed(false);
        UiTest tests;
        // Fixed ASCII arguments avoid command-line/path encoding ambiguity;
        // the owned working directory contains both current child reports.
        char program[] = "capture-ui-feedback-copy";
        char target[] = "completionFeedbackOutlivesOverlay";
        char output[] = "-o";
        char textReport[] = "copy.txt,txt";
        char junitReport[] = "copy.junit.xml,junitxml";
        char *arguments[] = {program,    target, output,
                             textReport, output, junitReport};
        result = QTest::qExec(&tests, 6, arguments);
      }
    }
    const bool cleanupComplete = desktop.close();
    auto report = desktop.evidence();
    report.insert("version", 1);
    report.insert("runToken", token);
    report.insert("pid", qint64(GetCurrentProcessId()));
    report.insert("qtestExitCode", result);
    report.insert("isolationWin32Error", qint64(isolationError));
    report.insert("cleanupComplete", cleanupComplete);
    QFile proof(QDir(reportDirectory).filePath("isolation.json"));
    const auto contents = QJsonDocument(report).toJson(QJsonDocument::Compact);
    if (!proof.open(QIODevice::WriteOnly | QIODevice::NewOnly) ||
        proof.write(contents) != contents.size() || !proof.flush())
      return 3;
    return result == 0 && cleanupComplete ? 0 : 2;
  }
  QApplication::setAttribute(Qt::AA_DontUseNativeDialogs);
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  app.setQuitOnLastWindowClosed(false);
  UiTest tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "ui_test.moc"
