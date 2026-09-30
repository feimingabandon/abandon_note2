#pragma once
#include "AnnotationEditor.h"
#include <functional>
namespace Capture {
class PinHalo;
class Feedback;
} // namespace Capture
class PinWindow : public QWidget {
  Q_OBJECT
public:
  explicit PinWindow(QImage image);
  explicit PinWindow(Capture::ImageDocument document, QString settingsPath = {},
                     QRect initialGeometry = {},
                     QScreen *initialScreen = nullptr);
  Capture::ImageDocument document;
  const QImage
      image; // Input backing; exportImage returns current annotated content.
  AnnotationEditor *annotations = nullptr;
  std::function<void(PinWindow *, bool)> closing;
  void constrain();
  bool placeAtPhysicalGeometry(QRect geometry);
  void resetScale();
  void setEditing(bool value);
  bool isEditing() const { return editing; }
  QImage exportImage();
  qint64 memoryCost() const;
  struct ViewState {
    QRect geometry;
    qreal opacity;
    double scale, previousScale;
    bool thumbnail, topmost;
  };
  ViewState viewState() const;
  void restoreView(const ViewState &state);
  void destroyPin();

protected:
  void paintEvent(QPaintEvent *) override;
  void mousePressEvent(QMouseEvent *) override;
  void mouseMoveEvent(QMouseEvent *) override;
  void mouseReleaseEvent(QMouseEvent *) override;
  void mouseDoubleClickEvent(QMouseEvent *) override;
  void wheelEvent(QWheelEvent *) override;
  void contextMenuEvent(QContextMenuEvent *) override;
  void keyPressEvent(QKeyEvent *) override;
  void resizeEvent(QResizeEvent *) override;
  void moveEvent(QMoveEvent *) override;
  void hideEvent(QHideEvent *) override;
  void showEvent(QShowEvent *) override;
  void closeEvent(QCloseEvent *) override;

private:
  friend class CapturePolishTest;
  QString settingsPath;
  Capture::PinHalo *halo = nullptr;
  Capture::Feedback *feedback = nullptr;
  QImage rendered;
  QPoint dragStart, origin;
  QPoint nativeDragStart;
  QRect initialNative;
  bool nativeDrag = false;
  QSize initialSize;
  bool resizing = false, dragging = false, topmost = true, editing = false,
       thumbnail = false, destroying = false;
  bool suppressContext = false;
  int resizeGrip = -1;
  double scale = 1, previousScale = 1;
  void scaleTo(double physicalScale);
  void opacityBy(double delta);
  void copyImage();
  void showFeedback(const QString &message, int duration = 1800);
  void saveImage(bool quick);
  void refresh();
  void placeToolbar();
  void transform(int key);
  void dragInPhysicalPixels(QMouseEvent *event);
};
