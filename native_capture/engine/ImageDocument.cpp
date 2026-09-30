#include "ImageDocument.h"
#include <QAbstractTextDocumentLayout>
#include <QFileInfo>
#include <QImageReader>
#include <QImageWriter>
#include <QPainter>
#include <QPainterPath>
#include <QSaveFile>
#include <QTextDocument>
#include <QtMath>
#include <algorithm>

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
QRectF Stroke::bounds() const {
  if (points.isEmpty())
    return {};
  if (tool == "text" && points.size() >= 2)
    return QRectF(points.first(), points.last()).normalized();
  QRectF r(points.first(), QSizeF(1, 1));
  for (auto p : points)
    r = r.united(QRectF(p, QSizeF(1, 1)));
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
// Effects sample the image as it existed before the effect. Erasing clears only
// this transparent annotation layer, never the captured pixels.
static void compositeStroke(QImage &layer, const QImage &base,
                            const Stroke &s) {
  if (s.tool == "mosaic" || s.tool == "blur") {
    if (!s.effectPixels.isNull()) {
      QPainter p(&layer);
      p.setCompositionMode(QPainter::CompositionMode_Source);
      p.drawImage(s.effectOrigin, s.effectPixels);
      return;
    }
    const auto r = s.bounds().toAlignedRect().intersected(base.rect());
    if (r.isEmpty())
      return;
    QImage patch = base.copy(r);
    {
      QPainter p(&patch);
      p.drawImage(-r.topLeft(), layer);
    }
    int block = std::max(2, s.width);
    patch = patch.scaled(std::max(1, r.width() / block),
                         std::max(1, r.height() / block), Qt::IgnoreAspectRatio,
                         Qt::SmoothTransformation);
    patch = patch.scaled(r.size(), Qt::IgnoreAspectRatio,
                         s.tool == "blur" ? Qt::SmoothTransformation
                                          : Qt::FastTransformation);
    QPainter p(&layer);
    p.setCompositionMode(QPainter::CompositionMode_Source);
    p.drawImage(r.topLeft(), patch);
  } else
    ImageDocument::draw(layer, s);
}
void ImageDocument::draw(QImage &image, const Stroke &s) {
  if (s.points.isEmpty())
    return;
  QRectF r(s.points.first(), s.points.last());
  r = r.normalized();
  if (s.tool == "mosaic" || s.tool == "blur") {
    auto bounds = r.toAlignedRect().intersected(image.rect());
    if (bounds.isEmpty())
      return;
    auto patch = image.copy(bounds).scaled(
        std::max(1, bounds.width() / std::max(2, s.width)),
        std::max(1, bounds.height() / std::max(2, s.width)),
        Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
    QPainter p(&image);
    p.setRenderHint(QPainter::SmoothPixmapTransform, s.tool == "blur");
    p.drawImage(bounds, patch);
    return;
  }
  QPainter p(&image);
  p.setRenderHint(QPainter::Antialiasing);
  p.setPen(QPen(s.color, s.width, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
  if (s.tool == "eraser")
    p.setCompositionMode(QPainter::CompositionMode_Clear);
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
bool ImageDocument::append(const Stroke &s, bool textDraft) {
  if (s.points.isEmpty() ||
      (!textDraft && s.tool == "text" && s.text.trimmed().isEmpty()))
    return false;
  redoStack.clear();
  strokes.push_back(s);
  editable = int(strokes.size()) - 1;
  if (strokes.size() > 100) {
    if (archivedLayer.isNull()) {
      archivedLayer = QImage(base.size(), QImage::Format_ARGB32_Premultiplied);
      archivedLayer.fill(Qt::transparent);
    }
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
  QImage layer = archivedLayer.copy();
  if (layer.isNull()) {
    layer = QImage(base.size(), QImage::Format_ARGB32_Premultiplied);
    layer.fill(Qt::transparent);
  }
  for (qsizetype i = 0; i < strokes.size(); ++i)
    if (i != hiddenStroke)
      compositeStroke(layer, base, strokes[i]);
  QImage result = base.copy();
  {
    QPainter p(&result);
    p.drawImage(0, 0, layer);
  }
  return transform.isIdentity() ? result : result.transformed(transform);
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
  QImage layer = archivedLayer.copy();
  if (layer.isNull()) {
    layer = QImage(base.size(), QImage::Format_ARGB32_Premultiplied);
    layer.fill(Qt::transparent);
  }
  // Replay redo in chronological order as well: restoring a cropped effect
  // must produce exactly the same pixels as restoring it before the crop.
  auto cacheEffect = [&](const Stroke &original, Stroke &cropped) {
    compositeStroke(layer, base, original);
    if (original.tool == "mosaic" || original.tool == "blur") {
      const QRect bounds =
          original.effectPixels.isNull()
              ? original.bounds().toAlignedRect()
              : QRect(original.effectOrigin, original.effectPixels.size());
      const auto visible = bounds.intersected(area);
      if (result.memoryCost() + qint64(visible.width()) * visible.height() * 4 >
          MaxTotalBytes)
        return false;
      cropped.effectPixels = visible.isEmpty() ? QImage() : layer.copy(visible);
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
    for (auto &s : *list)
      for (auto &p : s.points)
        p -= area.topLeft();
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
