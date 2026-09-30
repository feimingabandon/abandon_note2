#include "DesktopLayout.h"
#include "ImageDocument.h"
#include <QPainter>
#include <QStringList>
#include <algorithm>
#include <limits>

namespace Capture {
QRect DesktopLayout::bounds() const {
  QRect result;
  for (const auto &monitor : monitors)
    result = result.united(monitor.physical);
  return result;
}
int DesktopLayout::monitorAt(QPoint point) const {
  int chosen = -1;
  qint64 best = std::numeric_limits<qint64>::max();
  for (int i = 0; i < monitors.size(); ++i) {
    const auto r = monitors[i].physical;
    if (r.isEmpty())
      continue;
    const qint64 dx = point.x() - std::clamp(point.x(), r.left(), r.right());
    const qint64 dy = point.y() - std::clamp(point.y(), r.top(), r.bottom());
    const auto distance = dx * dx + dy * dy;
    if (distance < best) {
      best = distance;
      chosen = i;
    }
  }
  return chosen;
}
QRect DesktopLayout::toLogical(QRect rect) const {
  const auto index = monitorAt(rect.center());
  if (index < 0)
    return {};
  const auto &m = monitors[index];
  const double sx = double(m.logical.width()) / m.physical.width();
  const double sy = double(m.logical.height()) / m.physical.height();
  return {m.logical.x() + qRound((rect.x() - m.physical.x()) * sx),
          m.logical.y() + qRound((rect.y() - m.physical.y()) * sy),
          std::max(1, qRound(rect.width() * sx)),
          std::max(1, qRound(rect.height() * sy))};
}
QString DesktopLayout::signature() const {
  QStringList parts;
  for (const auto &m : monitors)
    parts << QString("%1,%2,%3,%4/%5,%6,%7,%8")
                 .arg(m.physical.x())
                 .arg(m.physical.y())
                 .arg(m.physical.width())
                 .arg(m.physical.height())
                 .arg(m.logical.x())
                 .arg(m.logical.y())
                 .arg(m.logical.width())
                 .arg(m.logical.height());
  parts.sort();
  return parts.join(';');
}
QImage composeDesktop(const DesktopLayout &layout,
                      const QVector<QImage> &frames, QString *error) {
  const auto bounds = layout.bounds();
  if (frames.size() != layout.monitors.size() ||
      !validImageSize(bounds.size())) {
    *error = QStringLiteral("桌面布局无效或合成图像超出 128 MiB 上限");
    return {};
  }
  for (int i = 0; i < frames.size(); ++i)
    if (frames[i].isNull() ||
        frames[i].size() != layout.monitors[i].physical.size()) {
      *error = QStringLiteral("显示器尺寸已改变，请重新截图");
      return {};
    }
  if (frames.size() == 1) {
    auto image = frames.first();
    image.setDevicePixelRatio(1);
    return image;
  }
  QImage result(bounds.size(), QImage::Format_ARGB32_Premultiplied);
  if (result.isNull()) {
    *error = QStringLiteral("无法分配桌面图像内存");
    return {};
  }
  // Unoccupied desktop gaps are transparent in PNG, never invented pixels.
  result.fill(Qt::transparent);
  QPainter painter(&result);
  painter.setCompositionMode(QPainter::CompositionMode_Source);
  for (int i = 0; i < frames.size(); ++i) {
    auto image = frames[i];
    image.setDevicePixelRatio(1);
    painter.drawImage(layout.monitors[i].physical.topLeft() - bounds.topLeft(),
                      image);
  }
  return result;
}
} // namespace Capture
