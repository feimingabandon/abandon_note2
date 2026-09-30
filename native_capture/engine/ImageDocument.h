#pragma once
#include <QColor>
#include <QImage>
#include <QPointF>
#include <QString>
#include <QTransform>
#include <QVector>

namespace Capture {
constexpr qint64 MiB = 1024 * 1024;
constexpr qint64 MaxImageBytes = 128 * MiB;
constexpr qint64 MaxTotalBytes = 512 * MiB;
bool validImageSize(QSize size, qint64 limit = MaxImageBytes);
QRect boundedSelection(QPoint a, QPoint b, QSize bounds);
QPoint toolbarPosition(QRect selection, QSize toolbar, QSize viewport);
QRect visiblePinGeometry(QRect requested, QRect screen);
QImage readImage(const QString &path, QString *error);
bool saveImage(const QImage &image, const QString &path, QString *error);
struct Stroke {
  QString tool;
  QVector<QPointF> points;
  QColor color = QColor("#0071e3");
  int width = 3;
  int fontSize = 24;
  QString text;
  QString fontFamily = "Microsoft YaHei UI";
  qreal rotation = 0;
  // A cropped effect keeps its sampled pixels until explicitly edited. This
  // preserves the original sampling grid while retaining undo/redo commands.
  QImage effectPixels;
  QPoint effectOrigin;
  QRectF bounds() const;
  QTransform localTransform() const;
};
class ImageDocument {
public:
  QImage base;
  QVector<Stroke> strokes;
  QVector<Stroke> redoStack;
  // Only the most recently created/redone object is editable (free-core model).
  int editable = -1;
  QImage archivedLayer;
  QTransform transform;
  bool append(const Stroke &stroke, bool textDraft = false);
  void undo();
  void redo();
  QImage render(int hiddenStroke = -1) const;
  void clear();
  ImageDocument cropped(QRect area) const;
  QTransform contentTransform() const;
  QSize outputSize() const;
  qint64 memoryCost() const;
  static void draw(QImage &image, const Stroke &stroke);
};
} // namespace Capture
