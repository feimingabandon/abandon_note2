#pragma once
#include <QImage>
#include <QObject>
#include <QPointer>
#include <memory>

class QWidget;
class QWindow;
namespace Capture {
QImage renderPinHaloStrip(QSize pixels, QRect physicalContent, qreal dpr);
// Display-only chrome: four narrow owned windows keep the image's geometry and
// backing store unchanged, even when a large pin is zoomed in.
class PinHalo : public QObject {
public:
  explicit PinHalo(QWidget *owner);
  ~PinHalo() override;
  void sync();
  qint64 memoryCost() const;

protected:
  bool eventFilter(QObject *, QEvent *) override;

private:
  QWidget *owner;
  struct State;
  std::unique_ptr<State> state;
  QPointer<QWindow> observedWindow;
  QMetaObject::Connection opacityConnection, screenConnection;
  bool syncing = false;
  void hide();
};
} // namespace Capture
