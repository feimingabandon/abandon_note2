#include "CaptureFeedback.h"
#include "CaptureAppearance.h"
#include "DesktopTargets.h"
#include <QApplication>
#include <QScreen>
#include <QToolTip>
#include <QVBoxLayout>
#include <algorithm>
#include <dwmapi.h>
#include <windows.h>

namespace Capture {
Feedback::Feedback(QWidget *owner)
    : QWidget(owner, Qt::ToolTip | Qt::FramelessWindowHint |
                         Qt::WindowStaysOnTopHint |
                         Qt::WindowDoesNotAcceptFocus |
                         Qt::WindowTransparentForInput) {
  setObjectName("captureFeedback");
  setAttribute(Qt::WA_ShowWithoutActivating);
  setAttribute(Qt::WA_TransparentForMouseEvents);
  setAttribute(Qt::WA_TranslucentBackground);
  setFocusPolicy(Qt::NoFocus);
  auto layout = new QVBoxLayout(this);
  layout->setContentsMargins(0, 0, 0, 0);
  auto panel = createChromePanel(this);
  layout->addWidget(panel);
  auto inner = new QVBoxLayout(panel);
  inner->setContentsMargins(14, 10, 14, 10);
  label = new QLabel(panel);
  label->setTextFormat(Qt::PlainText);
  label->setWordWrap(true);
  inner->addWidget(label);
  setStyleSheet(chromeStyle());
  connect(qApp, &QApplication::paletteChanged, this, [this] {
    setStyleSheet(chromeStyle());
    update();
  });
  timer.setSingleShot(true);
  connect(&timer, &QTimer::timeout, this, &QWidget::hide);
}
void Feedback::showMessage(const QString &message, QPoint anchorPoint,
                           int duration) {
  auto target = QGuiApplication::screenAt(anchorPoint);
  if (!target)
    target = QGuiApplication::primaryScreen();
  if (!target || message.isEmpty())
    return;
  const auto area = target->availableGeometry().adjusted(12, 12, -12, -12);
  setScreen(target);
  setMaximumWidth(std::max(1, std::min(560, area.width())));
  label->setText(message);
  adjustSize();
  move(std::clamp(anchorPoint.x() - width() / 2, area.left(),
                  std::max(area.left(), area.right() + 1 - width())),
       std::clamp(anchorPoint.y() + 16, area.top(),
                  std::max(area.top(), area.bottom() + 1 - height())));
  if (QGuiApplication::platformName() == "windows")
    SetPropW(reinterpret_cast<HWND>(winId()), DecorationProperty,
             reinterpret_cast<HANDLE>(1));
  show();
  timer.start(std::max(1, duration));
}
void Feedback::dismissBeforeCapture() {
  for (auto widget : QApplication::topLevelWidgets())
    if (auto feedback = qobject_cast<Feedback *>(widget)) {
      feedback->timer.stop();
      feedback->hide();
    } else if (widget->windowType() == Qt::ToolTip)
      widget->hide(); // QToolTip::hideText alone schedules a delayed hide.
  QToolTip::hideText();
  // Wait for Windows to remove decoration surfaces before BitBlt samples the
  // desktop. No event pumping here: a new capture must not be re-entered.
  if (QGuiApplication::platformName() == "windows")
    DwmFlush();
}
} // namespace Capture
