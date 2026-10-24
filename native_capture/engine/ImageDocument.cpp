#include "ImageDocument.h"
#include <QAbstractTextDocumentLayout>
#include <QBrush>
#include <QFileInfo>
#include <QImageReader>
#include <QImageWriter>
#include <QPainter>
#include <QPainterPath>
#include <QSaveFile>
#include <QTextDocument>
#include <QtMath>
#include <algorithm>
#include <cmath>

namespace Capture {
bool validImageSize(QSize s, qint64 limit) {
  return s.width() > 0 && s.height() > 0 &&
         qint64(s.width()) * s.height() <= limit / 4;
}
QRect boundedSelection(QPoint a, QPoint b, QSize s) {
  int x1 = std::clamp(std::min(a.x(), b.x()), 0, s.width());
  int y1 = std::clamp(std::min(a.y(), b.y()), 0, s.height());
  int x2 = std::clamp(std::max(a.x(), b.x()), 0, s.width());
  int y2 = std::clamp(std::max(a.y(), b.y()), 0, s.height());
  return QRect(x1, y1, x2 - x1, y2 - y1);
}
QPoint toolbarPosition(QRect r, QSize bar, QSize view) {
  int y = r.y() + r.height() + 8;
  if (y + bar.height() > view.height())
    y = r.y() - bar.height() - 8;
  return {std::clamp(r.x(), 0, std::max(0, view.width() - bar.width())),
          std::clamp(y, 0, std::max(0, view.height() - bar.height()))};
}
QImage readImage(const QString &path, QString *error) {
  QFileInfo file(path);
  const auto ext = file.suffix().toLower();
  if (!QStringList{"png", "jpg", "jpeg", "bmp", "webp"}.contains(ext) ||
      file.size() > 50 * MiB) {
    *error = QStringLiteral("仅支持不超过 50 MiB 的 PNG/JPEG/BMP/WebP 图片");
    return {};
  }
  QImageReader reader(path);
  reader.setDecideFormatFromContent(true);
  reader.setAutoTransform(true);
  if (!QList<QByteArray>{"png", "jpeg", "bmp", "webp"}.contains(
          reader.format()) ||
      reader.imageCount() > 1) {
    *error = QStringLiteral("不支持此图片格式或动画图片");
    return {};
  }
  if (!validImageSize(reader.size())) {
    *error = QStringLiteral("图片解码尺寸超出 128 MiB 上限");
    return {};
  }
  auto image = reader.read().convertToFormat(QImage::Format_ARGB32);
  if (image.isNull())
    *error = reader.errorString();
  return image;
}
QRect visiblePinGeometry(QRect requested, QRect screen) {
  if (screen.isEmpty())
    return requested;
  const int minX = screen.x() - std::max(0, requested.width() - screen.width());
  const int minY =
      screen.y() - std::max(0, requested.height() - screen.height());
  requested.moveTo(
      std::clamp(requested.x(), minX,
                 screen.x() + std::max(0, screen.width() - requested.width())),
      std::clamp(requested.y(), minY,
                 screen.y() +
                     std::max(0, screen.height() - requested.height())));
  return requested;
}
bool saveImage(const QImage &source, const QString &path, QString *error) {
  const auto ext = QFileInfo(path).suffix().toLower();
  if (ext != "png" && ext != "jpg" && ext != "jpeg") {
    *error = QStringLiteral("请使用 .png 或 .jpg 扩展名");
    return false;
  }
  QImage image = source;
  if (ext != "png") {
    image = QImage(source.size(), QImage::Format_RGB32);
    image.fill(Qt::white);
    QPainter p(&image);
    p.drawImage(0, 0, source);
  }
  QSaveFile file(path);
  if (!file.open(QIODevice::WriteOnly)) {
    *error = file.errorString();
    return false;
  }
  QImageWriter writer(&file, ext == "png" ? "png" : "jpeg");
  writer.setQuality(95);
  if (!writer.write(image)) {
    *error = writer.errorString();
    return false;
  }
  if (!file.commit()) {
    *error = file.errorString();
    return false;
  }
  return true;
}
bool Stroke::freehand() const {
  return tool == "pen" || tool == "marker" || tool == "eraser" ||
         (tool == "mosaic" && mosaicBrush);
}
QRectF Stroke::bounds() const {
  if (points.isEmpty())
    return {};
  if (tool == "text" && points.size() >= 2)
    return QRectF(points.first(), points.last()).normalized();
  QRectF r(points.first(), QSizeF(1, 1));
  for (auto p : points)
    r = r.united(QRectF(p, QSizeF(1, 1)));
  if (tool == "mosaic" && mosaicBrush) {
    const qreal radius = brushSize / 2.;
    r.adjust(-radius, -radius, radius, radius);
  }
  return r;
}
QTransform Stroke::localTransform() const {
  QTransform result;
  if (tool == "text") {
    const auto center = bounds().center();
    result.translate(center.x(), center.y());
    result.rotate(rotation);
    result.translate(-center.x(), -center.y());
  }
  return result;
}
// Sample a fixed image-space grid so extending a brush does not shift blocks
// that were already painted. Only the circular swept path receives the effect.
static QImage mosaicBrushPixels(const QImage &base, const Stroke &s,
                                QPoint &origin) {
  auto r = s.bounds().toAlignedRect().intersected(base.rect());
  if (!s.clipBounds.isEmpty())
    r = r.intersected(s.clipBounds);
  if (r.isEmpty() || s.points.isEmpty())
    return {};
  const int block = std::max(2, s.width);
  const QPoint grid(r.x() / block * block, r.y() / block * block);
  const QRect sampleRect =
      QRect(grid, QPoint((r.right() / block + 1) * block - 1,
                         (r.bottom() / block + 1) * block - 1))
          .intersected(base.rect());
  auto source = base.copy(sampleRect)
                    .convertToFormat(QImage::Format_ARGB32_Premultiplied);
  QImage effect(r.size(), QImage::Format_ARGB32_Premultiplied);
  effect.fill(Qt::transparent);
  for (int y = grid.y(); y <= r.bottom(); y += block)
    for (int x = grid.x(); x <= r.right(); x += block) {
      const QRect cell = QRect(x, y, block, block).intersected(base.rect());
      qint64 red = 0, green = 0, blue = 0, alpha = 0;
      for (int cy = cell.top(); cy <= cell.bottom(); ++cy) {
        const auto row = reinterpret_cast<const QRgb *>(
            source.constScanLine(cy - sampleRect.y()));
        for (int cx = cell.left(); cx <= cell.right(); ++cx) {
          const auto pixel = row[cx - sampleRect.x()];
          red += qRed(pixel);
          green += qGreen(pixel);
          blue += qBlue(pixel);
          alpha += qAlpha(pixel);
        }
      }
      const auto count = qint64(cell.width()) * cell.height();
      const QRgb average =
          qRgba(red / count, green / count, blue / count, alpha / count);
      const auto target = cell.intersected(r).translated(-r.topLeft());
      for (int ty = target.top(); ty <= target.bottom(); ++ty) {
        auto row = reinterpret_cast<QRgb *>(effect.scanLine(ty));
        std::fill(row + target.left(), row + target.right() + 1, average);
      }
    }
  QImage mask(r.size(), QImage::Format_ARGB32_Premultiplied);
  mask.fill(Qt::transparent);
  {
    QPainter p(&mask);
    p.setRenderHint(QPainter::Antialiasing);
    p.translate(-r.topLeft());
    p.setPen(QPen(Qt::white, s.brushSize, Qt::SolidLine, Qt::RoundCap,
                  Qt::RoundJoin));
    QPainterPath path(s.points.first());
    for (int i = 1; i < s.points.size(); ++i)
      path.lineTo(s.points[i]);
    if (std::all_of(s.points.begin(), s.points.end(),
                    [&](QPointF pt) { return pt == s.points.first(); }))
      p.drawPoint(s.points.first());
    else
      p.drawPath(path);
  }
  {
    QPainter p(&effect);
    p.setCompositionMode(QPainter::CompositionMode_DestinationIn);
    p.drawImage(0, 0, mask);
  }
  origin = r.topLeft();
  return effect;
}
// A normalized Gaussian kernel (sigma = radius / 3), evaluated as two 1D
// convolutions. Only the selected region and its finite sampling halo are read;
// premultiplied channels avoid dark fringes around transparent image pixels.
static QImage gaussianPixels(const QImage &base, const Stroke &s,
                             QPoint &origin) {
  const int radius = std::clamp(s.width, 1, 32);
  const double sigma = std::max(0.5, radius / 3.0);
  auto limits = base.rect();
  if (!s.clipBounds.isEmpty())
    limits = limits.intersected(s.clipBounds);
  const auto area = s.bounds().toAlignedRect().intersected(limits);
  if (area.isEmpty())
    return {};
  const auto samples = area.adjusted(-radius, -radius, radius, radius)
                           .intersected(limits);
  auto source = base.copy(samples)
                    .convertToFormat(QImage::Format_ARGB32_Premultiplied);
  if (source.isNull())
    return {};
  QVector<double> gaussian(radius * 2 + 1);
  double total = 0;
  for (int i = -radius; i <= radius; ++i) {
    gaussian[i + radius] = std::exp(-double(i * i) / (2 * sigma * sigma));
    total += gaussian[i + radius];
  }
  // Fixed point keeps the inner loop inexpensive and preserves solid colors.
  constexpr int unity = 1 << 16;
  QVector<int> weights(gaussian.size());
  int sum = 0;
  for (qsizetype i = 0; i < gaussian.size(); ++i) {
    weights[i] = qRound(gaussian[i] / total * unity);
    sum += weights[i];
  }
  weights[radius] += unity - sum;
  QImage horizontal(area.width(), samples.height(),
                    QImage::Format_ARGB32_Premultiplied);
  QImage result(area.size(), QImage::Format_ARGB32_Premultiplied);
  if (horizontal.isNull() || result.isNull())
    return {};
  const auto rounded = [](int value) { return (value + unity / 2) / unity; };
  for (int y = 0; y < source.height(); ++y) {
    const auto input = reinterpret_cast<const QRgb *>(source.constScanLine(y));
    auto output = reinterpret_cast<QRgb *>(horizontal.scanLine(y));
    for (int x = 0; x < area.width(); ++x) {
      int red = 0, green = 0, blue = 0, alpha = 0;
      const int center = x + area.x() - samples.x();
      for (int i = -radius; i <= radius; ++i) {
        const auto pixel = input[std::clamp(center + i, 0, source.width() - 1)];
        const int weight = weights[i + radius];
        red += qRed(pixel) * weight;
        green += qGreen(pixel) * weight;
        blue += qBlue(pixel) * weight;
        alpha += qAlpha(pixel) * weight;
      }
      output[x] = qRgba(rounded(red), rounded(green), rounded(blue),
                        rounded(alpha));
    }
  }
  QVector<const QRgb *> rows(weights.size());
  for (int y = 0; y < area.height(); ++y) {
    auto output = reinterpret_cast<QRgb *>(result.scanLine(y));
    const int center = y + area.y() - samples.y();
    for (int i = -radius; i <= radius; ++i)
      rows[i + radius] = reinterpret_cast<const QRgb *>(
          horizontal.constScanLine(std::clamp(center + i, 0, horizontal.height() - 1)));
    for (int x = 0; x < area.width(); ++x) {
      int red = 0, green = 0, blue = 0, alpha = 0;
      for (qsizetype i = 0; i < rows.size(); ++i) {
        const auto pixel = rows[i][x];
        const int weight = weights[i];
        red += qRed(pixel) * weight;
        green += qGreen(pixel) * weight;
        blue += qBlue(pixel) * weight;
        alpha += qAlpha(pixel) * weight;
      }
      output[x] = qRgba(rounded(red), rounded(green), rounded(blue),
                        rounded(alpha));
    }
  }
  origin = area.topLeft();
  return result;
}
static void drawStroke(QImage &image, const Stroke &s,
                       const QImage *eraseSource = nullptr);

// Accumulate complete image pixels: effect patches already contain their
// sampled background and must replace it, including transparent pixels.
// Keep the original base separately so erasing can restore it after archiving.
static void compositeStroke(QImage &image, const QImage &base, const Stroke &s,
                            QImage *effect = nullptr,
                            QPoint *origin = nullptr) {
  if (s.effectDraft)
    return;
  if (s.tool == "mosaic" || s.tool == "blur") {
    QImage patch;
    QPoint at;
    if (!s.effectPixels.isNull()) {
      patch = s.effectPixels;
      at = s.effectOrigin;
    } else if (s.tool == "mosaic" && s.mosaicBrush) {
      patch = mosaicBrushPixels(image, s, at);
    } else if (s.tool == "blur") {
      patch = gaussianPixels(image, s, at);
    } else {
      auto r = s.bounds().toAlignedRect().intersected(base.rect());
      if (!s.clipBounds.isEmpty())
        r = r.intersected(s.clipBounds);
      if (r.isEmpty())
        return;
      patch = image.copy(r);
      int block = std::max(2, s.width);
      patch = patch.scaled(std::max(1, r.width() / block),
                           std::max(1, r.height() / block),
                           Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
      patch = patch.scaled(r.size(), Qt::IgnoreAspectRatio, Qt::FastTransformation);
      at = r.topLeft();
    }
    if (effect)
      *effect = patch;
    if (origin)
      *origin = at;
    QPainter p(&image);
    p.setCompositionMode(s.mosaicBrush ? QPainter::CompositionMode_SourceOver
                                       : QPainter::CompositionMode_Source);
    p.drawImage(at, patch);
  } else
    drawStroke(image, s, &base);
}
static void drawStroke(QImage &image, const Stroke &s,
                       const QImage *eraseSource) {
  if (s.points.isEmpty() || s.effectDraft)
    return;
  QRectF r(s.points.first(), s.points.last());
  r = r.normalized();
  if (s.tool == "mosaic" && s.mosaicBrush) {
    QPoint at;
    const auto patch = mosaicBrushPixels(image, s, at);
    QPainter p(&image);
    p.drawImage(at, patch);
    return;
  }
  if (s.tool == "blur") {
    QPoint at;
    const auto patch = gaussianPixels(image, s, at);
    QPainter p(&image);
    p.setCompositionMode(QPainter::CompositionMode_Source);
    p.drawImage(at, patch);
    return;
  }
  if (s.tool == "mosaic") {
    auto bounds = r.toAlignedRect().intersected(image.rect());
    if (bounds.isEmpty())
      return;
    auto patch = image.copy(bounds).scaled(
        std::max(1, bounds.width() / std::max(2, s.width)),
        std::max(1, bounds.height() / std::max(2, s.width)),
        Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
    QPainter p(&image);
    p.drawImage(bounds, patch);
    return;
  }
  QPainter p(&image);
  p.setRenderHint(QPainter::Antialiasing);
  if (!s.clipBounds.isEmpty())
    p.setClipRect(s.clipBounds);
  p.setPen(QPen(s.color, s.width, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
  if (s.tool == "eraser") {
    if (eraseSource) {
      // Source, rather than SourceOver, restores even fully transparent base
      // pixels. The antialiased brush edge blends restored and edited pixels.
      p.setCompositionMode(QPainter::CompositionMode_Source);
      p.setPen(QPen(QBrush(*eraseSource), s.width, Qt::SolidLine, Qt::RoundCap,
                    Qt::RoundJoin));
    } else
      p.setCompositionMode(QPainter::CompositionMode_Clear);
  }
  if (s.tool == "marker")
    p.setOpacity(0.32);
  if (s.tool == "rectangle")
    p.drawRect(r);
  else if (s.tool == "ellipse")
    p.drawEllipse(r);
  else if (s.tool == "pen" || s.tool == "marker" || s.tool == "eraser" ||
           s.tool == "polyline") {
    QPainterPath path(s.points.first());
    for (int i = 1; i < s.points.size(); ++i)
      path.lineTo(s.points[i]);
    if (std::all_of(s.points.begin(), s.points.end(),
                    [&](QPointF pt) { return pt == s.points.first(); }))
      p.drawPoint(s.points.first());
    else
      p.drawPath(path);
  } else if (s.tool == "line") {
    p.drawLine(s.points.first(), s.points.last());
  } else if (s.tool == "arrow") {
    auto a = s.points.first(), b = s.points.last();
    p.drawLine(a, b);
    double angle = std::atan2(b.y() - a.y(), b.x() - a.x());
    double length = std::max(12, s.width * 4);
    p.drawLine(b, b - QPointF(std::cos(angle - 0.5) * length,
                              std::sin(angle - 0.5) * length));
    p.drawLine(b, b - QPointF(std::cos(angle + 0.5) * length,
                              std::sin(angle + 0.5) * length));
  } else if (s.tool == "text") {
    QFont font(s.fontFamily);
    font.setPixelSize(s.fontSize);
    p.setFont(font);
    p.translate(r.center());
    p.rotate(s.rotation);
    p.translate(-r.center());
    // Match the QTextEdit preview's layout rather than QPainter's different
    // word-wrap/line-height rules, including multiline Chinese text.
    QTextDocument text;
    text.setDocumentMargin(0);
    text.setDefaultFont(font);
    text.setPlainText(s.text);
    text.setTextWidth(r.width());
    p.setClipRect(r);
    p.translate(r.topLeft());
    QAbstractTextDocumentLayout::PaintContext context;
    context.palette.setColor(QPalette::Text, s.color);
    text.documentLayout()->draw(&p, context);
  }
}
void ImageDocument::draw(QImage &image, const Stroke &s) {
  drawStroke(image, s);
}
bool ImageDocument::append(const Stroke &s, bool textDraft) {
  if (s.points.isEmpty() ||
      (!textDraft && s.tool == "text" && s.text.trimmed().isEmpty()))
    return false;
  redoStack.clear();
  strokes.push_back(s);
  editable = int(strokes.size()) - 1;
  if (strokes.size() > 100) {
    if (archivedLayer.isNull())
      archivedLayer = base.copy();
    compositeStroke(archivedLayer, base, strokes.takeFirst());
    --editable;
    return true;
  }
  return false;
}
void ImageDocument::undo() {
  editable = -1;
  if (!strokes.isEmpty())
    redoStack.push_back(strokes.takeLast());
}
void ImageDocument::redo() {
  if (!redoStack.isEmpty()) {
    strokes.push_back(redoStack.takeLast());
    editable = int(strokes.size()) - 1;
  }
}
QImage ImageDocument::render(int hiddenStroke) const {
  if (strokes.isEmpty() && archivedLayer.isNull())
    return transform.isIdentity() ? base : base.transformed(transform);
  QImage result = archivedLayer.isNull() ? base.copy() : archivedLayer.copy();
  for (qsizetype i = 0; i < strokes.size(); ++i)
    if (i != hiddenStroke)
      compositeStroke(result, base, strokes[i]);
  return transform.isIdentity() ? result : result.transformed(transform);
}
qint64 ImageDocument::gaussianWorkingCost(const Stroke &stroke) const {
  const int radius = std::clamp(stroke.width, 1, 32);
  auto limits = base.rect();
  if (!stroke.clipBounds.isEmpty())
    limits = limits.intersected(stroke.clipBounds);
  const auto area = stroke.bounds().toAlignedRect().intersected(limits);
  if (area.isEmpty())
    return 0;
  const auto samples = area.adjusted(-radius, -radius, radius, radius)
                           .intersected(limits);
  // Existing image composite plus regional source, intermediate, and result.
  return base.sizeInBytes() +
         (qint64(samples.width()) * samples.height() +
          qint64(area.width()) * samples.height() +
          qint64(area.width()) * area.height()) * 4;
}
bool ImageDocument::cacheEffect(int index) {
  if (index < 0 || index >= strokes.size() || strokes[index].tool != "blur")
    return false;
  auto &stroke = strokes[index];
  if (!stroke.effectPixels.isNull()) {
    stroke.effectDraft = false;
    return true;
  }
  if (memoryCost() + gaussianWorkingCost(stroke) > MaxTotalBytes)
    return false;
  QImage layer = archivedLayer.isNull() ? base.copy() : archivedLayer.copy();
  if (layer.isNull())
    return false;
  for (int i = 0; i < index; ++i)
    compositeStroke(layer, base, strokes[i]);
  QPoint origin;
  auto pixels = gaussianPixels(layer, stroke, origin);
  if (pixels.isNull())
    return false;
  stroke.effectPixels = std::move(pixels);
  stroke.effectOrigin = origin;
  stroke.effectDraft = false;
  return true;
}
void ImageDocument::clear() {
  strokes.clear();
  redoStack.clear();
  archivedLayer = {};
  editable = -1;
}
ImageDocument ImageDocument::cropped(QRect area) const {
  ImageDocument result = *this;
  area = area.intersected(base.rect());
  result.base = base.copy(area);
  if (!archivedLayer.isNull())
    result.archivedLayer = archivedLayer.copy(area);
  QImage layer = archivedLayer.isNull() ? base.copy() : archivedLayer.copy();
  // Replay redo in chronological order as well: restoring a cropped effect
  // must produce exactly the same pixels as restoring it before the crop.
  auto cacheEffect = [&](const Stroke &original, Stroke &cropped) {
    QImage pixels;
    QPoint origin;
    compositeStroke(layer, base, original, &pixels, &origin);
    if (original.tool == "mosaic" || original.tool == "blur") {
      const QRect bounds(origin, pixels.size());
      const auto visible = bounds.intersected(area);
      if (result.memoryCost() + qint64(visible.width()) * visible.height() * 4 >
          MaxTotalBytes)
        return false;
      cropped.effectPixels = visible.isEmpty()
                                 ? QImage()
                                 : pixels.copy(visible.translated(-origin));
      cropped.effectOrigin = visible.topLeft() - area.topLeft();
    }
    return true;
  };
  for (qsizetype i = 0; i < strokes.size(); ++i)
    if (!cacheEffect(strokes[i], result.strokes[i]))
      return {};
  for (qsizetype i = redoStack.size(); i-- > 0;)
    if (!cacheEffect(redoStack[i], result.redoStack[i]))
      return {};
  for (auto list : {&result.strokes, &result.redoStack})
    for (auto &s : *list) {
      for (auto &p : s.points)
        p -= area.topLeft();
      if (!s.clipBounds.isEmpty())
        s.clipBounds = s.clipBounds.translated(-area.topLeft());
    }
  return result;
}
QTransform ImageDocument::contentTransform() const {
  return QImage::trueMatrix(transform, base.width(), base.height());
}
QSize ImageDocument::outputSize() const {
  return contentTransform().mapRect(QRect(QPoint(), base.size())).size();
}
qint64 ImageDocument::memoryCost() const {
  qint64 total = base.sizeInBytes() + archivedLayer.sizeInBytes();
  for (auto list : {&strokes, &redoStack})
    for (const auto &s : *list)
      total += s.points.size() * sizeof(QPointF) + s.text.size() * 2 +
               s.effectPixels.sizeInBytes();
  return total;
}
} // namespace Capture
