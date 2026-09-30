#include "AnnotationEditor.h"
#include <QApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QFile>
#include <QtTest>
#include <cstdio>

struct Canvas : QWidget {
  Capture::ImageDocument doc;
  AnnotationEditor *editor;
  Canvas() {
    setObjectName("reviewCanvas");
    setFocusPolicy(Qt::StrongFocus);
    resize(800, 600);
    doc.base = QImage(800, 600, QImage::Format_ARGB32_Premultiplied);
    doc.base.fill(Qt::white);
    editor = new AnnotationEditor(this, doc);
    editor->editBounds = doc.base.rect();
  }
  void keyPressEvent(QKeyEvent *e) override { editor->key(e); }
  void drag(QPointF from, QPointF to) {
    QMouseEvent press(QEvent::MouseButtonPress, from, from, Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
    editor->press(&press);
    QMouseEvent move(QEvent::MouseMove, to, to, Qt::NoButton, Qt::LeftButton, Qt::NoModifier);
    editor->move(&move);
    QMouseEvent release(QEvent::MouseButtonRelease, to, to, Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
    editor->release(&release);
  }
};
static int differences(const QImage &a, const QImage &b) {
  if (a.size() != b.size()) return -1;
  int count = 0;
  for (int y=0; y<a.height(); ++y)
    for (int x=0; x<a.width(); ++x) count += a.pixel(x,y) != b.pixel(x,y);
  return count;
}
int main(int argc, char **argv) {
  QApplication app(argc, argv);
  QJsonObject results;
  {
    Canvas c;
    c.show(); c.activateWindow();
    c.editor->panel->show();
    c.editor->choose("rectangle");
    auto size = c.findChild<QSpinBox *>("annotationSize");
    size->setValue(8);
    c.editor->choose("ellipse"); c.editor->choose("rectangle");
    results["widthAfterSwitchingAwayAndBack"] = size->value();
    size->setFocus(); size->selectAll(); QApplication::processEvents();
    auto focused = QApplication::focusWidget();
    results["focusBeforeTyping"] = focused ? focused->objectName() : "null";
    if (focused) QTest::keyClick(focused, Qt::Key_2);
    QApplication::processEvents();
    focused = QApplication::focusWidget();
    results["focusAfterFirstDigit"] = focused ? focused->objectName() : "null";
    if (focused) QTest::keyClick(focused, Qt::Key_4);
    results["valueAfterTyping24"] = size->value();
  }
  {
    Canvas c;
    Capture::Stroke s{"text", {{100, 100}, {200, 150}}, Qt::black, 3, 24, "Example"};
    c.doc.append(s); c.editor->sync();
    c.drag({200, 150}, {300, 200});
    results["fontSizeAfterDoublingTextFrame"] = c.doc.strokes.last().fontSize;
    results["textFrameWidthAfterResize"] = c.doc.strokes.last().bounds().width();
  }
  {
    Canvas c;
    c.editor->choose("eraser");
    c.drag({100, 100}, {200, 200});
    c.drag({150, 150}, {240, 150});
    results["eraserStrokeCountAfterTwoDrags"] = c.doc.strokes.size();
    results["firstEraserPointXAfterSecondDrag"] = c.doc.strokes.first().points.first().x();
  }
  for (QString tool : {"mosaic", "blur"}) {
    Capture::ImageDocument doc;
    doc.base = QImage(160, 120, QImage::Format_ARGB32_Premultiplied);
    for (int y=0; y<120; ++y)
      for (int x=0; x<160; ++x)
        doc.base.setPixelColor(x,y,QColor((x*13+y*7)%256,(x*11+y*3)%256,(x*3+y*17)%256));
    doc.append({tool, {{20, 20}, {140, 100}}, Qt::black, 12});
    QRect crop(45, 30, 80, 70);
    auto before = doc.render().copy(crop), after = doc.cropped(crop).render();
    results[tool + "CropDifferentPixels"] = differences(before, after);
    before.save(tool + "-before.png"); after.save(tool + "-pinned.png");
  }
  QByteArray bytes = QJsonDocument(results).toJson();
  QFile out("results.json"); out.open(QIODevice::WriteOnly); out.write(bytes);
  std::fwrite(bytes.constData(), 1, bytes.size(), stdout);
  return 0;
}
