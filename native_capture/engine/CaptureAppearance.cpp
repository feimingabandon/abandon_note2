#include "CaptureAppearance.h"
#include <QApplication>
#include <QIconEngine>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QWheelEvent>

namespace Capture {
class ChromePanel final : public QWidget {
public:
  using QWidget::QWidget;
  // Empty toolbar space is still chrome, never an input target on the image.
  void mousePressEvent(QMouseEvent *event) override { event->accept(); }
  void mouseReleaseEvent(QMouseEvent *event) override { event->accept(); }
  void mouseMoveEvent(QMouseEvent *event) override { event->accept(); }
  void wheelEvent(QWheelEvent *event) override { event->accept(); }
  void paintEvent(QPaintEvent *) override {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    auto edge = qApp->palette().windowText().color();
    edge.setAlphaF(.12);
    p.setPen(QPen(edge, 1));
    p.setBrush(qApp->palette().window());
    p.drawRoundedRect(QRectF(rect()).adjusted(.5, .5, -.5, -.5), 10, 10);
  }
};
QWidget *createChromePanel(QWidget *parent) { return new ChromePanel(parent); }
// Project-authored vector icons. Render paths at the requested device scale;
// no font glyphs, fixed-resolution source pixmaps or external icon runtime.
class ActionIcon final : public QIconEngine {
  QString name;
  bool primary;

public:
  ActionIcon(QString id, bool filled) : name(std::move(id)), primary(filled) {}
  QIconEngine *clone() const override { return new ActionIcon(name, primary); }
  void paint(QPainter *p, const QRect &rect, QIcon::Mode mode,
             QIcon::State state) override {
    p->save();
    p->setRenderHint(QPainter::Antialiasing);
    const qreal side = qMin(rect.width(), rect.height());
    p->translate(rect.x() + (rect.width() - side) / 2,
                 rect.y() + (rect.height() - side) / 2);
    p->scale(side / 24., side / 24.);
    QColor ink =
        primary ? QColor(Qt::white) : qApp->palette().windowText().color();
    if (!primary && state == QIcon::On)
      ink = QColor("#0071e3");
    if (mode == QIcon::Disabled)
      ink.setAlphaF(.28);
    p->setPen(QPen(ink, 1.65, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    p->setBrush(Qt::NoBrush);
    auto line = [&](qreal x1, qreal y1, qreal x2, qreal y2) {
      p->drawLine(QPointF(x1, y1), QPointF(x2, y2));
    };
    auto path = [&](std::initializer_list<QPointF> points) {
      QPainterPath v;
      bool first = true;
      for (auto pt : points) {
        if (first)
          v.moveTo(pt);
        else
          v.lineTo(pt);
        first = false;
      }
      p->drawPath(v);
    };
    if (name == "rectangle")
      p->drawRoundedRect(QRectF(4, 5, 16, 14), 2, 2);
    else if (name == "ellipse")
      p->drawEllipse(QRectF(4, 4, 16, 16));
    else if (name == "line" || name == "arrow") {
      line(5, 19, 19, 5);
      if (name == "arrow")
        path({{10, 5}, {19, 5}, {19, 14}});
    } else if (name == "polyline")
      path({{4, 17}, {9, 7}, {15, 17}, {20, 7}});
    else if (name == "select")
      path({{5, 3},
            {5, 19},
            {9, 15},
            {13, 21},
            {16, 19},
            {12, 13},
            {19, 12},
            {5, 3}});
    else if (name == "pen") {
      path({{4, 20}, {5, 15}, {16, 4}, {20, 8}, {9, 19}, {4, 20}});
      line(13, 7, 17, 11);
    } else if (name == "marker") {
      path({{5, 14}, {14, 5}, {19, 10}, {10, 19}, {5, 14}});
      path({{5, 14}, {3, 19}, {8, 19}});
      line(13, 6, 18, 11);
      line(3, 22, 17, 22);
    } else if (name == "text") {
      path({{4, 6}, {4, 4}, {20, 4}, {20, 6}});
      line(12, 4, 12, 20);
      line(8, 20, 16, 20);
    } else if (name == "mosaic") {
      for (int y = 4; y <= 14; y += 10)
        for (int x = 4; x <= 14; x += 10)
          p->drawRoundedRect(QRectF(x, y, 6, 6), 1, 1);
    } else if (name == "blur") {
      p->drawEllipse(QRectF(7, 7, 10, 10));
      for (int i = 0; i < 8; ++i) {
        p->save();
        p->translate(12, 12);
        p->rotate(i * 45);
        line(0, -9, 0, -8);
        p->restore();
      }
    } else if (name == "eraser") {
      path({{3, 14}, {13, 4}, {21, 12}, {13, 20}, {9, 20}, {3, 14}});
      line(8, 9, 16, 17);
      line(13, 20, 21, 20);
    } else if (name == "undo" || name == "redo") {
      if (name == "redo") {
        p->translate(24, 0);
        p->scale(-1, 1);
      }
      path({{8, 5}, {4, 9}, {8, 13}});
      QPainterPath v;
      v.moveTo(4, 9);
      v.lineTo(14, 9);
      v.cubicTo(22, 9, 22, 20, 14, 20);
      p->drawPath(v);
    } else if (name == "copy")
      path({{5, 12}, {10, 17}, {20, 6}});
    else if (name == "save") {
      path({{12, 3}, {12, 15}, {7, 10}});
      line(12, 15, 17, 10);
      path({{4, 15}, {4, 20}, {20, 20}, {20, 15}});
    } else if (name == "quickSave") {
      path({{13, 2}, {5, 13}, {11, 13}, {10, 22}, {19, 10}, {13, 10}, {13, 2}});
    } else if (name == "pin") {
      path({{8, 3}, {16, 3}, {15, 10}, {19, 14}, {5, 14}, {9, 10}, {8, 3}});
      line(12, 14, 12, 21);
    } else if (name == "cancel") {
      line(6, 6, 18, 18);
      line(18, 6, 6, 18);
    } else if (name == "clear") {
      path({{7, 7}, {8, 20}, {16, 20}, {17, 7}});
      line(4, 7, 20, 7);
      path({{9, 7}, {9, 4}, {15, 4}, {15, 7}});
    } else if (name == "full") {
      path({{9, 4}, {4, 4}, {4, 9}});
      path({{15, 4}, {20, 4}, {20, 9}});
      path({{4, 15}, {4, 20}, {9, 20}});
      path({{15, 20}, {20, 20}, {20, 15}});
    } else if (name == "note" || name == "source") {
      p->drawRoundedRect(QRectF(4, 3, 16, 18), 2, 2);
      line(8, 8, 16, 8);
      line(8, 12, 16, 12);
      line(8, 16, 12, 16);
    } else if (name == "background") {
      p->drawRoundedRect(QRectF(3, 4, 18, 16), 2, 2);
      p->drawEllipse(QRectF(7, 7, 3, 3));
      path({{3, 17}, {9, 12}, {13, 16}, {17, 12}, {21, 16}});
    } else if (name == "color") {
      p->drawEllipse(QRectF(4, 4, 16, 16));
      line(12, 8, 12, 16);
      line(8, 12, 16, 12);
    } else {
      p->setBrush(ink);
      for (int x = 5; x <= 19; x += 7)
        p->drawEllipse(QPointF(x, 12), 1, 1);
    }
    p->restore();
  }
  QPixmap pixmap(const QSize &size, QIcon::Mode mode,
                 QIcon::State state) override {
    QPixmap pix(size);
    pix.fill(Qt::transparent);
    QPainter painter(&pix);
    paint(&painter, QRect(QPoint(), size), mode, state);
    return pix;
  }
  QPixmap scaledPixmap(const QSize &size, QIcon::Mode mode, QIcon::State state,
                       qreal scale) override {
    auto pix = pixmap(size * scale, mode, state);
    pix.setDevicePixelRatio(scale);
    return pix;
  }
};
QIcon actionIcon(const QString &name, bool primary) {
  return QIcon(new ActionIcon(name, primary));
}
static QColor blend(QColor bg, QColor ink, qreal strength) {
  return QColor::fromRgbF(bg.redF() * (1 - strength) + ink.redF() * strength,
                          bg.greenF() * (1 - strength) +
                              ink.greenF() * strength,
                          bg.blueF() * (1 - strength) + ink.blueF() * strength);
}
void applyTheme(const QJsonObject &theme) {
  QColor bg(theme["background"].toString("#ffffff"));
  QColor ink(theme["foreground"].toString("#1d1d1f"));
  if (!bg.isValid() || !ink.isValid())
    return;
  QPalette palette = qApp->palette();
  palette.setColor(QPalette::Window, bg);
  palette.setColor(QPalette::Base, bg);
  palette.setColor(QPalette::WindowText, ink);
  palette.setColor(QPalette::Text, ink);
  palette.setColor(QPalette::Button, bg);
  palette.setColor(QPalette::ButtonText, ink);
  palette.setColor(QPalette::Highlight, QColor("#0071e3"));
  palette.setColor(QPalette::HighlightedText, Qt::white);
  qApp->setPalette(palette);
}
QString chromeStyle() {
  const auto bg = qApp->palette().window().color(),
             ink = qApp->palette().windowText().color();
  // Native counterparts of surface-float, border-control, fill-hover and
  // fill-pressed in tokens.css. Only accent/on-primary are fixed semantic
  // colors.
  return QString(R"(
    QWidget#annotationPanel{background:%1;border:1px solid %3;border-radius:10px;}
    QToolBar{border:0;spacing:3px;padding:0;background:transparent;}
    QToolBar::separator{background:%3;width:1px;margin:7px 5px;}
    QToolButton{color:%2;background:transparent;border:1px solid transparent;border-radius:6px;padding:5px;}
    QToolButton:hover{background:%4;}
    QToolButton:pressed{background:%5;padding-top:6px;padding-bottom:4px;}
    QToolButton:checked{background:%6;}
    QToolButton:focus{border-color:#0071e3;}
    QToolButton#capturePrimary{background:#0071e3;color:white;padding-left:9px;padding-right:9px;}
    QToolButton#capturePrimary:hover{background:#0064c8;}
    QToolButton::menu-indicator{image:none;width:0;}
    QSpinBox,QComboBox{color:%2;background:%1;border:1px solid %3;border-radius:5px;min-height:26px;padding:0 5px;}
    QSpinBox:hover,QComboBox:hover{border-color:%7;}
    QSpinBox:focus,QComboBox:focus{border-color:#0071e3;}
    QLabel{color:%2;background:transparent;}
    QMenu{color:%2;background:%1;border:1px solid %3;padding:5px;}
    QMenu::item{padding:7px 18px;border-radius:4px;}
    QMenu::item:selected{background:%4;}
    QMenu::item:disabled{color:%7;}
    QToolTip{color:%2;background:%1;border:1px solid %3;padding:5px;}
  )")
      .arg(bg.name(), ink.name(), blend(bg, ink, .12).name(),
           blend(bg, ink, .04).name(), blend(bg, ink, .10).name(),
           blend(bg, QColor("#0071e3"), .12).name(), blend(bg, ink, .4).name());
}
} // namespace Capture
