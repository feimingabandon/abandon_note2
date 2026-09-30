#include "SelectionSnap.h"
#include <QRegion>
#include <algorithm>
#include <cstdlib>

namespace Capture {
void SelectionSnap::reset(QRect bounds, const QVector<QRect> &screens,
                          const QVector<QRect> &windows) {
  xEdges.clear();
  yEdges.clear();
  auto add = [&](QRect r, const QRegion &visible) {
    // QRect's right/bottom are inclusive; selection boundaries are exclusive.
    for (int x : {r.x(), r.x() + r.width()}) {
      auto parts = visible.intersected(
          QRect(x == r.x() ? x : x - 1, r.y(), 1, r.height()));
      for (const auto &p : parts)
        xEdges << QLine(x, p.y(), x, p.y() + p.height());
    }
    for (int y : {r.y(), r.y() + r.height()}) {
      auto parts = visible.intersected(
          QRect(r.x(), y == r.y() ? y : y - 1, r.width(), 1));
      for (const auto &p : parts)
        // Stored transposed so the same search handles both axes.
        yEdges << QLine(y, p.x(), y, p.x() + p.width());
    }
  };
  QRegion desktop;
  for (auto r : screens) {
    r = r.intersected(bounds);
    desktop += r;
    add(r, QRegion(r));
  }
  QRegion covered;
  for (const auto r : windows) {
    add(r, QRegion(r).intersected(desktop).subtracted(covered));
    covered += r;
  }
}
int SelectionSnap::delta(int value, int from, int to,
                         const QVector<QLine> &edges, int threshold) {
  int best = threshold + 1, distance = threshold + 1;
  for (auto line : edges) {
    const auto d = line.x1() - value;
    if (std::abs(d) < distance && to >= line.y1() - threshold &&
        from <= line.y2() + threshold) {
      best = d;
      distance = std::abs(d);
    }
  }
  return best;
}
QPoint SelectionSnap::point(QPoint raw, int threshold, bool horizontal,
                            bool vertical) const {
  const auto dx = delta(raw.x(), raw.y(), raw.y(), xEdges, threshold);
  const auto dy = delta(raw.y(), raw.x(), raw.x(), yEdges, threshold);
  return raw + QPoint(horizontal && std::abs(dx) <= threshold ? dx : 0,
                      vertical && std::abs(dy) <= threshold ? dy : 0);
}
QRect SelectionSnap::move(QRect raw, int threshold, QRect bounds) const {
  const int left =
      delta(raw.x(), raw.y(), raw.y() + raw.height(), xEdges, threshold);
  const int right = delta(raw.x() + raw.width(), raw.y(),
                          raw.y() + raw.height(), xEdges, threshold);
  const int top =
      delta(raw.y(), raw.x(), raw.x() + raw.width(), yEdges, threshold);
  const int bottom = delta(raw.y() + raw.height(), raw.x(),
                           raw.x() + raw.width(), yEdges, threshold);
  auto nearer = [threshold](int a, int b) {
    const int chosen = std::abs(a) <= std::abs(b) ? a : b;
    return std::abs(chosen) <= threshold ? chosen : 0;
  };
  raw.translate(nearer(left, right), nearer(top, bottom));
  raw.moveTo(std::clamp(raw.x(), bounds.x(),
                        bounds.x() + bounds.width() - raw.width()),
             std::clamp(raw.y(), bounds.y(),
                        bounds.y() + bounds.height() - raw.height()));
  return raw;
}
} // namespace Capture
