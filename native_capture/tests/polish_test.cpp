#include "AnnotationEditor.h"
#include "CaptureEngine.h"
#include "CaptureFeedback.h"
#include "DesktopCapture.h"
#include "SaveActions.h"
#include <QApplication>
#include <QElapsedTimer>
#include <QFileDialog>
#include <QMessageBox>
#include <QProcess>
#include <QProcessEnvironment>
#include <QSettings>
#include <QTemporaryDir>
#include <QtTest>
#include <algorithm>
#include <dwmapi.h>
#include <windows.h>

namespace {
Capture::ImageDocument document(QSize size = {800, 600}) {
  Capture::ImageDocument d;
  d.base = QImage(size, QImage::Format_RGB32);
  d.base.fill(Qt::white);
  return d;
}
QSpinBox *sizeControl(QWidget &w) {
  return w.findChild<QSpinBox *>("annotationSize");
}
QComboBox *colorControl(QWidget &w) {
  return w.findChild<QComboBox *>("annotationColor");
}
void point(AnnotationEditor *editor, QEvent::Type type, QPointF position,
           Qt::MouseButton button, Qt::MouseButtons buttons) {
  QMouseEvent event(type, position, position, button, buttons, Qt::NoModifier);
  if (type == QEvent::MouseButtonPress)
    editor->press(&event);
  else if (type == QEvent::MouseButtonRelease)
    editor->release(&event);
  else
    editor->move(&event);
}
} // namespace

class CapturePolishTest : public QObject {
  Q_OBJECT
private slots:
  void preferencesSurviveEditorsAndRemainSelective() {
    QTemporaryDir temp;
    const auto path = temp.filePath("capture.ini");
    auto firstDoc = document(), staleDoc = document();
    QWidget first, stale;
    AnnotationEditor firstEditor(&first, firstDoc, path);
    AnnotationEditor staleEditor(&stale, staleDoc, path);
    firstEditor.choose("rectangle");
    sizeControl(first)->setValue(9);
    colorControl(first)->setCurrentIndex(1);
    firstEditor.choose("mosaic");
    sizeControl(first)->setValue(28);
    firstEditor.choose("text");
    sizeControl(first)->setValue(36);
    first.findChild<QFontComboBox *>("annotationFont")
        ->setCurrentFont(QFont("Arial"));
    staleEditor.choose("pen");
    sizeControl(stale)->setValue(7);

    // Inspecting an old stroke and changing rotation must not persist its
    // color, font or size over the user's chosen defaults.
    firstDoc.append({"text", {{10, 10}, {100, 60}}, Qt::green, 2, 18, "old"});
    firstEditor.sync();
    first.findChild<QSpinBox *>("annotationRotation")->setValue(45);
    firstEditor.action("undo")->trigger();
    firstEditor.action("redo")->trigger();
    {
      auto freshDoc = document();
      QWidget fresh;
      AnnotationEditor editor(&fresh, freshDoc, path);
      QCOMPARE(editor.tool, QString("select"));
      editor.choose("rectangle");
      QCOMPARE(sizeControl(fresh)->value(), 9);
      QCOMPARE(colorControl(fresh)->currentData().value<QColor>(),
               QColor("#e13c39"));
      editor.choose("mosaic");
      QCOMPARE(sizeControl(fresh)->value(), 28);
      editor.choose("pen");
      QCOMPARE(sizeControl(fresh)->value(), 7);
      editor.choose("text");
      QCOMPARE(sizeControl(fresh)->value(), 36);
      QCOMPARE(fresh.findChild<QFontComboBox *>("annotationFont")
                   ->currentFont()
                   .family(),
               QString("Arial"));
      QCOMPARE(fresh.findChild<QSpinBox *>("annotationRotation")->value(), 0);
    }
    // Verify actual screenshot and pin constructors both forward the path.
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), document().base,
                           "global", {}, path);
    overlay.annotations->choose("rectangle");
    QCOMPARE(sizeControl(overlay)->value(), 9);
    PinWindow pin(document(), path);
    pin.annotations->choose("mosaic");
    QCOMPARE(sizeControl(pin)->value(), 28);
  }
  void invalidPreferencesFallBack() {
    QTemporaryDir temp;
    const auto path = temp.filePath("capture.ini");
    {
      QSettings settings(path, QSettings::IniFormat);
      settings.setValue("annotation/color", "not a color");
      settings.setValue("annotation/fontFamily", QString(500, 'x'));
      settings.setValue("annotation/fontSize", 99999);
      settings.setValue("annotation/width/pen", -4);
      settings.setValue("annotation/width/blur", "bad");
    }
    auto doc = document();
    QWidget canvas;
    AnnotationEditor editor(&canvas, doc, path);
    editor.choose("text");
    QCOMPARE(sizeControl(canvas)->value(), 24);
    QCOMPARE(colorControl(canvas)->currentData().value<QColor>(),
             QColor("#0071e3"));
    editor.choose("pen");
    QCOMPARE(sizeControl(canvas)->value(), 3);
    editor.choose("blur");
    QCOMPARE(sizeControl(canvas)->value(), 12);
  }
  void preferencesReloadInNewProcess() {
    const auto supplied = qEnvironmentVariable("CAPTURE_POLISH_PREFS");
    if (!supplied.isEmpty()) {
      auto doc = document();
      QWidget canvas;
      AnnotationEditor editor(&canvas, doc, supplied);
      QCOMPARE(editor.tool, QString("select"));
      editor.choose("arrow");
      QCOMPARE(sizeControl(canvas)->value(), 13);
      QCOMPARE(colorControl(canvas)->currentData().value<QColor>(),
               QColor("#32a852"));
      return;
    }
    QTemporaryDir temp;
    const auto path = temp.filePath("capture.ini");
    {
      auto doc = document();
      QWidget canvas;
      AnnotationEditor editor(&canvas, doc, path);
      editor.choose("arrow");
      sizeControl(canvas)->setValue(13);
      colorControl(canvas)->setCurrentIndex(3);
    }
    QProcess process;
    auto environment = QProcessEnvironment::systemEnvironment();
    environment.insert("CAPTURE_POLISH_PREFS", path);
    process.setProcessEnvironment(environment);
    process.start(QCoreApplication::applicationFilePath(),
                  {"preferencesReloadInNewProcess", "-silent"});
    QVERIFY(process.waitForFinished(10000));
    const auto output =
        process.readAllStandardOutput() + process.readAllStandardError();
    QVERIFY2(process.exitStatus() == QProcess::NormalExit &&
                 process.exitCode() == 0,
             output.constData());
  }
  void detectionRetriesLatestPointAndRejectsStaleResults() {
    CaptureOverlay o(QGuiApplication::primaryScreen(), document().base,
                     "global");
    o.resize(800, 600);
    o.nativeBounds = {0, 0, 800, 600};
    o.targets = {{1, {0, 0, 800, 600}}};
    o.detectionMode = 1;
    o.hover = {100, 100};
    bool busy = false;
    QVector<QPoint> queries;
    QVector<std::function<void(QRect)>> callbacks;
    o.controlLookup = [&](QObject *, quintptr, QPoint p, auto callback) {
      if (busy)
        return false;
      busy = true;
      queries << p;
      callbacks << callback;
      return true;
    };
    o.detect();
    QCOMPARE(queries.size(), 1);
    o.hover = {200, 200};
    o.detect();
    QVERIFY(o.detector.isActive());
    callbacks.first()({80, 80, 80, 80});
    QCOMPARE(o.detected, QRect(0, 0, 800, 600));
    busy = false;
    QTRY_COMPARE_WITH_TIMEOUT(queries.size(), 2, 1000);
    QCOMPARE(queries.last(), QPoint(200, 200));
    callbacks.last()({180, 180, 80, 80});
    QCOMPARE(o.detected, QRect(180, 180, 80, 80));
    QVERIFY(o.hint->text().contains(QStringLiteral("已识别控件")));
    // A stale result must stay stale even after the pointer returns to A.
    o.hover = {100, 100};
    o.detect();
    callbacks.first()({80, 80, 80, 80});
    QCOMPARE(o.detected, QRect(0, 0, 800, 600));
    o.selectAll();
    QVERIFY(!o.detector.isActive());
    callbacks.last()({180, 180, 80, 80});
    QCOMPARE(o.selection, QRect(0, 0, 800, 600));
  }
  void detectionFallbackAndModeSwitch() {
    CaptureOverlay o(QGuiApplication::primaryScreen(), document().base,
                     "global");
    o.resize(800, 600);
    o.nativeBounds = {0, 0, 800, 600};
    o.targets = {{1, {0, 0, 800, 600}}};
    o.hover = {150, 150};
    o.detectionMode = 1;
    o.controlLookup = [](QObject *, quintptr, QPoint, auto callback) {
      callback({});
      return true;
    };
    o.detect();
    QCOMPARE(o.detected, QRect(0, 0, 800, 600));
    QVERIFY(o.hint->text().contains(QStringLiteral("未识别到子控件")));
    o.controlLookup = [](QObject *, quintptr, QPoint, auto) { return false; };
    o.detect();
    QVERIFY(o.detector.isActive());
    QTest::keyClick(&o, Qt::Key_Tab);
    QCOMPARE(o.detectionMode, 0);
    QVERIFY(!o.detector.isActive());
  }
  void contextualHintsAndHelpLifetime() {
    auto o = new CaptureOverlay(QGuiApplication::primaryScreen(),
                                document().base, "global");
    QPointer<CaptureOverlay> guard(o);
    o->resize(800, 600);
    o->selectAll();
    QVERIFY(o->hint->text().contains(QStringLiteral("方向键")));
    o->annotations->choose("arrow");
    QVERIFY(o->hint->text().contains(QStringLiteral("Tab 切换直线/箭头")));
    QVERIFY(!o->hint->text().contains(QStringLiteral("窗口")));
    o->annotations->choose("polyline");
    QVERIFY(o->hint->text().contains(QStringLiteral("右键完成折线")));
    o->annotations->choose("text");
    point(o->annotations, QEvent::MouseButtonPress, {80, 80}, Qt::LeftButton,
          Qt::LeftButton);
    QVERIFY(o->annotations->typing());
    QVERIFY(o->hint->text().contains("Ctrl+Enter"));
    o->annotations->action("help")->trigger();
    QPointer<QMessageBox> help = o->findChild<QMessageBox *>("captureHelp");
    QVERIFY(help);
    QCOMPARE(help->textFormat(), Qt::PlainText);
    o->annotations->action("help")->trigger();
    QCOMPARE(o->findChildren<QMessageBox *>("captureHelp").size(), 1);
    o->close();
    QTRY_VERIFY(guard.isNull());
    QVERIFY(help.isNull());
  }
  void savedPathAndFeedbackLifecycle() {
    QTemporaryDir temp;
    const auto path = temp.filePath("capture.ini");
    {
      QSettings prefs(path, QSettings::IniFormat);
      prefs.setValue("quickSaveDirectory", temp.path());
    }
    QWidget owner;
    QString saved, error;
    auto base = document({80, 60}).base;
    QVERIFY(Capture::saveWithDialog(&owner, base, true, path, &error, &saved));
    QVERIFY(QFileInfo::exists(saved));
    QCOMPARE(QImage(saved), base);
    Capture::Feedback f;
    const auto area = QGuiApplication::primaryScreen()->availableGeometry();
    f.showMessage(QStringLiteral("已保存\n%1").arg(saved), area.bottomRight(),
                  100);
    QVERIFY(f.isVisible());
    QVERIFY(area.contains(f.geometry()));
    QCOMPARE(f.findChild<QLabel *>()->textFormat(), Qt::PlainText);
    QTRY_VERIFY_WITH_TIMEOUT(!f.isVisible(), 1000);
    f.showMessage("copied", area.center());
    Capture::Feedback::dismissBeforeCapture();
    QVERIFY(!f.isVisible());
    // Failure must not return a previous successful path.
    {
      QSettings prefs(path, QSettings::IniFormat);
      prefs.setValue("quickSaveDirectory", temp.filePath("missing"));
    }
    QVERIFY(!Capture::saveWithDialog(&owner, base, true, path, &error, &saved));
    QVERIFY(saved.isEmpty());
    QVERIFY(!error.isEmpty());
    error.clear();
    saved = "previous path";
    QTimer::singleShot(0, [] {
      for (auto widget : QApplication::topLevelWidgets())
        if (auto dialog = qobject_cast<QFileDialog *>(widget))
          dialog->reject();
    });
    QVERIFY(
        !Capture::saveWithDialog(&owner, base, false, path, &error, &saved));
    QVERIFY(saved.isEmpty());
    QVERIFY(error.isEmpty());
  }
  void pinFeedbackValuesDoNotChangeExport() {
    PinWindow pin(document({320, 200}));
    pin.setAttribute(Qt::WA_DeleteOnClose, false);
    pin.show();
    const auto original = pin.exportImage();
    pin.scaleTo(1.5);
    QVERIFY(pin.feedback->isVisible());
    QVERIFY(pin.feedback->findChild<QLabel *>()->text().contains("150%"));
    pin.opacityBy(-0.2);
    QVERIFY(pin.feedback->findChild<QLabel *>()->text().contains("80%"));
    pin.resetScale();
    QCOMPARE(pin.feedback->findChild<QLabel *>()->text(),
             QStringLiteral("缩放 100% · 透明度 100%"));
    QCOMPARE(pin.exportImage(), original);
    pin.hide();
    QVERIFY(!pin.feedback->isVisible());
  }
  void nativeFeedbackDoesNotStealFocusOrBecomeTarget() {
    if (QGuiApplication::platformName() != "windows" ||
        !Capture::interactiveDesktopAvailable())
      QSKIP("Requires an unlocked Windows desktop");
    QWidget owner;
    owner.resize(500, 300);
    owner.setStyleSheet("background:#245080");
    owner.show();
    owner.activateWindow();
    QTRY_VERIFY(owner.isActiveWindow());
    // Activation can precede initial painting/presentation. Wait for the
    // synthetic fixture here, never after hiding feedback: that would mask
    // capture contamination.
    owner.repaint();
    QTest::qWait(80);
    const auto active = GetForegroundWindow();
    QString error;
    DwmFlush();
    const auto before = Capture::captureDesktop(owner.screen(), &error);
    QVERIFY2(!before.isNull(), qPrintable(error));
    Capture::Feedback feedback(&owner);
    feedback.showMessage("native feedback", owner.geometry().center());
    QTest::qWait(50);
    QCOMPARE(GetForegroundWindow(), active);
    const auto targets = Capture::desktopTargets();
    QVERIFY(std::none_of(targets.begin(), targets.end(),
                         [&](auto t) { return t.window == feedback.winId(); }));
    Capture::Feedback::dismissBeforeCapture();
    QVERIFY(!IsWindowVisible(reinterpret_cast<HWND>(feedback.winId())));
    const auto after = Capture::captureDesktop(owner.screen(), &error);
    const auto area =
        Capture::physicalWindowRect(feedback.winId())
            .translated(-Capture::nativeScreenRect(owner.screen()).topLeft());
    const auto clean = before.copy(area), captured = after.copy(area);
    if (captured != clean)
      qInfo() << "Feedback region" << area << "before/after center"
              << clean.pixelColor(clean.rect().center())
              << captured.pixelColor(captured.rect().center());
    QCOMPARE(captured, clean);
  }
  void drawing4kTiming_data() {
    QTest::addColumn<QString>("tool");
    for (QString tool : {"pen", "mosaic", "blur"})
      QTest::newRow(qPrintable(tool)) << tool;
  }
  void drawing4kTiming() {
    QFETCH(QString, tool);
    auto doc = document({3840, 2160});
    {
      QPainter p(&doc.base);
      for (int x = 0; x < 3840; x += 17)
        p.fillRect(x, 0, 4, 2160, Qt::black);
    }
    CaptureOverlay overlay(QGuiApplication::primaryScreen(), doc.base,
                           "global");
    overlay.resize(1920, 1080);
    overlay.selectAll();
    for (int i = 0; i < 12; ++i)
      overlay.document.append(
          {"arrow", {{100. + i * 80, 80.}, {500. + i * 80, 700.}}, Qt::red, 5});
    overlay.document.editable = -1;
    overlay.annotations->choose(tool);
    point(overlay.annotations, QEvent::MouseButtonPress, {20, 20},
          Qt::LeftButton, Qt::LeftButton);
    QVector<double> times;
    for (int i = 0; i < 65; ++i) {
      QElapsedTimer timer;
      timer.start();
      point(overlay.annotations, QEvent::MouseMove,
            {800. + i * 5, 420. + i * 3}, Qt::NoButton, Qt::LeftButton);
      const double ms = timer.nsecsElapsed() / 1.e6;
      if (i >= 5)
        times << ms;
    }
    point(overlay.annotations, QEvent::MouseButtonRelease, {1120, 612},
          Qt::LeftButton, Qt::NoButton);
    std::sort(times.begin(), times.end());
    qInfo().noquote()
        << QString("4K %1: handler+composite median=%2ms p95=%3ms max=%4ms, 60 "
                   "samples, 12 prior arrows; excludes desktop presentation")
               .arg(tool)
               .arg(times[30], 0, 'f', 2)
               .arg(times[56], 0, 'f', 2)
               .arg(times.last(), 0, 'f', 2);
    QCOMPARE(overlay.rendered, overlay.document.render());
    QCOMPARE(overlay.document.base, doc.base);
  }
};
int main(int argc, char **argv) {
  QApplication::setAttribute(Qt::AA_DontUseNativeDialogs);
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  app.setQuitOnLastWindowClosed(false);
  CapturePolishTest tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "polish_test.moc"
