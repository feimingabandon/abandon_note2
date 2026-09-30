#pragma once
#include <QLine>
#include <QRect>
#include <QVector>

namespace Capture {
class SelectionSnap {
public:
  // Input rectangles are in image pixels, ordered front to back.
  void reset(QRect bounds, const QVector<QRect> &screens,
             const QVector<QRect> &windows);
  QPoint point(QPoint raw, int threshold, bool horizontal = true,
               bool vertical = true) const;
  QRect move(QRect raw, int threshold, QRect bounds) const;

private:
  QVector<QLine> xEdges, yEdges;
  static int delta(int value, int from, int to, const QVector<QLine> &edges,
                   int threshold);
};
} // namespace Capture
