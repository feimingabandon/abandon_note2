#pragma once
#include "AnnotationEditor.h"
#include "DesktopLayout.h"
#include "DesktopTargets.h"
#include "SelectionSnap.h"
#include <QLabel>
#include <QTimer>
#include <functional>
class CaptureOverlay : public QWidget {
  Q_OBJECT
public:
  CaptureOverlay(QScreen *screen, QImage image, QString origin,
                 Capture::DesktopLayout layout = {}, QString settingsPath = {});
  std::function<bool(CaptureOverlay *)> claim;
  std::function<void()> clearClaim, cancel;
  std::function<void(QString, QImage)> output;
  void showError(const QString &error);
  void showDesktop();
  void selectAll();
  QRect selectionGeometry() const;
  QRect selectionPhysicalGeometry() const;
  QScreen *selectionScreen() const;
  QString desktopSignature() const;
  bool placementValid = true;
  QRect selection, recalledSelection;
  Capture::ImageDocument document;
  AnnotationEditor *annotations;

protected:
  bool event(QEvent *) override;
  void closeEvent(QCloseEvent *) override;
  void paintEvent(QPaintEvent *) override;
  void mousePressEvent(QMouseEvent *) override;
  void mouseMoveEvent(QMouseEvent *) override;
  void mouseReleaseEvent(QMouseEvent *) override;
  void mouseDoubleClickEvent(QMouseEvent *) override;
  void keyPressEvent(QKeyEvent *) override;
  void keyReleaseEvent(QKeyEvent *) override;
  void wheelEvent(QWheelEvent *) override;

private:
  friend class SelectionTest;
  friend class CapturePolishTest;
  QLabel *hint = nullptr;
  QImage rendered;
  QString origin, drag;
  QPoint anchor, last, hover;
  QRect beforeDrag, rawSelection, detected, nativeBounds;
  Capture::DesktopLayout desktop;
  Capture::SelectionSnap snapping;
  QVector<Capture::DesktopTarget> targets;
  int handle = -1, detectionMode = 0, toolbarMonitor = 0;
  bool space = false, alt = false, hex = true, barHidden = false;
  QTimer detector;
  quint64 detectionSerial = 0;
  std::function<bool(QObject *, quintptr, QPoint, std::function<void(QRect)>)>
      controlLookup = Capture::accessibleTarget;
  QPoint pixel(QPointF) const;
  QRect logical(QRect) const;
  QVector<QPoint> handles() const;
  void refresh();
  void placeToolbar();
  void finish(QString action);
  void clearSelection();
  void detect();
  void detectionHint(const QString &status = {});
  void rebuildSnapTargets();
  int snapThreshold(QPoint point) const;
  void updateDrag(QPoint point, bool bypass);
  QRect monitorViewport(int index) const;
  int monitorAt(QPoint point) const;
};
