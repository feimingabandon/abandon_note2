#include "CaptureOverlay.h"
#include "PinWindow.h"
#include <QApplication>
#include <QMouseEvent>
#include <QWheelEvent>
#include <QtTest>
#include <cstdio>

static void choose(CaptureOverlay &overlay, const QString &label) {
  for (auto action : overlay.findChild<QToolBar *>()->actions())
    if (action->text() == label) { action->trigger(); return; }
  qFatal("Missing requested test tool");
}
static void rect(const char *id, const QRect &r) {
  std::printf("%s: x=%d y=%d width=%d height=%d\n", id, r.x(), r.y(), r.width(), r.height());
}
int main(int argc, char **argv) {
  QApplication app(argc, argv);
  app.setQuitOnLastWindowClosed(false);
  QImage blank(800, 600, QImage::Format_RGB32);
  blank.fill(Qt::white);
  CaptureOverlay overlay(QGuiApplication::primaryScreen(), blank, "global");
  overlay.setAttribute(Qt::WA_DeleteOnClose, false);
  overlay.resize(800, 600);
  overlay.show();
  QString output;
  overlay.output = [&](QString action, QImage) { output = action; };
  overlay.selection = {100, 100, 200, 150};
  QTest::mouseDClick(&overlay, Qt::LeftButton, Qt::NoModifier, {200, 200});
  rect("double_click_selection", overlay.selection);
  std::printf("double_click_output: %s\n", qPrintable(output.isEmpty() ? "none" : output));
  overlay.selection = {100, 100, 200, 150};
  QTest::mouseClick(&overlay, Qt::MiddleButton, Qt::NoModifier, {200, 200});
  std::printf("middle_click_output: %s\n", qPrintable(output.isEmpty() ? "none" : output));
  QTest::keyClick(&overlay, Qt::Key_Right, Qt::ControlModifier);
  rect("ctrl_right_selection", overlay.selection);
  overlay.selection = {100, 100, 200, 150};
  QTest::keyClick(&overlay, Qt::Key_Right, Qt::ShiftModifier);
  rect("shift_right_selection", overlay.selection);
  overlay.selectAll();
  choose(overlay, QStringLiteral("矩形"));
  auto actions = overlay.findChild<QToolBar *>()->actions();
  std::printf("toolbar_checked_actions: %lld\n", std::count_if(actions.begin(), actions.end(), [](auto a) { return a->isChecked(); }));
  QTest::mousePress(&overlay, Qt::LeftButton, Qt::ShiftModifier, {150, 180});
  QMouseEvent move(QEvent::MouseMove, QPointF(280, 230), QPointF(280, 230), Qt::NoButton, Qt::LeftButton, Qt::ShiftModifier);
  QApplication::sendEvent(&overlay, &move);
  QTest::mouseRelease(&overlay, Qt::LeftButton, Qt::ShiftModifier, {280, 230});
  const auto shape = overlay.document.strokes.last();
  std::printf("shift_rectangle: width=%.0f height=%.0f\n", shape.points.last().x()-shape.points.first().x(), shape.points.last().y()-shape.points.first().y());
  const auto count = overlay.document.strokes.size();
  choose(overlay, QStringLiteral("文字"));
  QTest::mouseClick(&overlay, Qt::LeftButton, Qt::NoModifier, {200, 300});
  auto editor = overlay.findChild<QTextEdit *>();
  if (!editor) qFatal("Test text editor missing");
  editor->setPlainText("comparison sample");
  QTest::mouseClick(&overlay, Qt::RightButton, Qt::NoModifier, {600, 400});
  std::printf("right_click_text_added_strokes: %lld\n", overlay.document.strokes.size()-count);
  QTest::keyClick(&overlay, Qt::Key_Space);
  std::printf("space_toolbar_visible: %s\n", overlay.findChild<QToolBar *>()->isVisible() ? "true" : "false");
  overlay.close();

  QImage source(300, 200, QImage::Format_RGB32);
  source.fill(Qt::white);
  PinWindow pin(source);
  pin.setAttribute(Qt::WA_DeleteOnClose, false);
  pin.resize(300, 200);
  pin.show();
  QWheelEvent wheel(QPointF(100, 50), QPointF(100, 50), QPoint(), QPoint(0, 120), Qt::NoButton, Qt::ControlModifier, Qt::NoScrollPhase, false);
  QApplication::sendEvent(&pin, &wheel);
  std::printf("pin_ctrl_wheel: width=%d opacity=%.2f\n", pin.width(), pin.windowOpacity());
  pin.setWindowOpacity(0.5);
  pin.resize(150, 100);
  QTest::mouseClick(&pin, Qt::MiddleButton, Qt::NoModifier, {50, 50});
  std::printf("pin_middle_click_reset: width=%d height=%d opacity=%.2f\n", pin.width(), pin.height(), pin.windowOpacity());
  QTest::keyClick(&pin, Qt::Key_Space);
  std::printf("pin_space_toolbars: %lld\n", pin.findChildren<QToolBar *>().size());
  return 0;
}
