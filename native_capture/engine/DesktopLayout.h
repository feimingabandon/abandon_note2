#pragma once
#include <QImage>
#include <QRect>
#include <QString>
#include <QVector>

namespace Capture {
struct DesktopMonitor {
  QRect physical;
  QRect logical;
};
// All capture pixels and selection coordinates use the native desktop lattice.
// Qt's per-monitor logical rectangles can contain gaps even for adjacent
// panels.
struct DesktopLayout {
  QVector<DesktopMonitor> monitors;
  QRect bounds() const;
  int monitorAt(QPoint physical) const;
  QRect toLogical(QRect physical) const;
  QString signature() const;
};
QImage composeDesktop(const DesktopLayout &layout,
                      const QVector<QImage> &frames, QString *error);
} // namespace Capture
