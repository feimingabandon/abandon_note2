#pragma once
#include <QLabel>
#include <QTimer>
#include <QWidget>

namespace Capture {
// Short-lived display chrome. It never owns keyboard focus or receives input.
class Feedback final : public QWidget {
  Q_OBJECT
public:
  explicit Feedback(QWidget *owner = nullptr);
  void showMessage(const QString &message, QPoint anchorPoint,
                   int duration = 1800);
  static void dismissBeforeCapture();

private:
  QLabel *label;
  QTimer timer;
};
} // namespace Capture
