#include "ImageDocument.h"
#include <QPainter>
#include <QTemporaryDir>
#include <QtTest>
class CoreTest : public QObject {
  Q_OBJECT
private slots:
  void pinPlacementAcrossScreens() {
    QCOMPARE(
        Capture::visiblePinGeometry({900, 700, 400, 300}, {0, 0, 1000, 800}),
        QRect(600, 500, 400, 300));
    QCOMPARE(Capture::visiblePinGeometry({-1800, 100, 300, 200},
                                         {-1920, 0, 1920, 1080}),
             QRect(-1800, 100, 300, 200));
    QCOMPARE(Capture::visiblePinGeometry({-2000, 100, 300, 200},
                                         {-1920, 0, 1920, 1080}),
             QRect(-1920, 100, 300, 200));
    QCOMPARE(
        Capture::visiblePinGeometry({300, 400, 1200, 900}, {0, 0, 1000, 800}),
        QRect(0, 0, 1200, 900));
  }
  void cropPreservesEffectsAndHistory() {
    for (QString tool : {"mosaic", "blur"}) {
      Capture::ImageDocument d;
      d.base = QImage(160, 120, QImage::Format_ARGB32_Premultiplied);
      for (int y = 0; y < 120; ++y)
        for (int x = 0; x < 160; ++x)
          d.base.setPixelColor(x, y,
                               QColor((x * 13 + y * 7) % 256,
                                      (x * 11 + y * 3) % 256,
                                      (x * 3 + y * 17) % 256));
      d.append({"arrow", {{35, 45}, {130, 70}}, Qt::red, 8});
      const auto beforeEffect = d.render();
      d.append({tool, {{20, 20}, {140, 100}}, Qt::black, 12});
      const QRect area(45, 30, 80, 70);
      auto crop = d.cropped(area);
      QCOMPARE(crop.render(), d.render().copy(area));
      const auto expected = crop.render();
      crop.undo();
      QCOMPARE(crop.render(), beforeEffect.copy(area));
      crop.redo();
      QCOMPARE(crop.render(), expected);
      QCOMPARE(crop.cropped({10, 5, 60, 50}).render(),
               expected.copy(10, 5, 60, 50));
      d.undo();
      auto withRedo = d.cropped(area);
      withRedo.redo();
      QCOMPARE(withRedo.render(), expected);
      crop.append({"eraser", {{10, 10}, {60, 60}}, Qt::black, 18});
      QCOMPARE(crop.render().pixelColor(30, 30), crop.base.pixelColor(30, 30));
      crop.clear();
      QCOMPARE(crop.render(), d.base.copy(area));
    }
  }
  void bounds() {
    QCOMPARE(Capture::boundedSelection({90, 70}, {10, 20}, {100, 100}),
             QRect(10, 20, 80, 50));
    QCOMPARE(Capture::boundedSelection({-20, -10}, {200, 150}, {100, 100}),
             QRect(0, 0, 100, 100));
    QCOMPARE(Capture::boundedSelection({0, 0}, {1, 1}, {100, 100}).size(),
             QSize(1, 1));
    QVERIFY(!Capture::validImageSize({INT_MAX, INT_MAX}));
    QVERIFY(!Capture::validImageSize({0, 2}));
  }
  void toolbar() {
    for (auto s : QList<QRect>{
             {0, 0, 1920, 1080}, {1800, 1000, 100, 79}, {0, 0, 1, 1}}) {
      auto p = Capture::toolbarPosition(s, {500, 50}, {1920, 1080});
      QVERIFY(p.x() >= 0 && p.y() >= 0);
      QVERIFY(p.x() + 500 <= 1920 && p.y() + 50 <= 1080);
    }
  }
  void annotations() {
    Capture::ImageDocument d;
    d.base = QImage(100, 100, QImage::Format_ARGB32);
    d.base.fill(Qt::white);
    Capture::Stroke s{"rectangle", {{10, 10}, {70, 70}}, Qt::red, 3};
    d.append(s);
    auto marked = d.render();
    QVERIFY(marked != d.base);
    d.undo();
    QCOMPARE(d.render(), d.base);
    d.redo();
    QCOMPARE(d.render(), marked);
    for (int i = 0; i < 105; ++i)
      d.append(s);
    QCOMPARE(d.strokes.size(), 100);
    Capture::Stroke mosaic{"mosaic", {{0, 0}, {100, 100}}};
    d.append(mosaic);
    QVERIFY(d.render() != marked);
  }
  void formats() {
    QTemporaryDir dir;
    QString error;
    QImage image(20, 30, QImage::Format_ARGB32);
    image.fill(Qt::transparent);
    QVERIFY(Capture::saveImage(image, dir.filePath("a.png"), &error));
    QCOMPARE(Capture::readImage(dir.filePath("a.png"), &error), image);
    QVERIFY(Capture::saveImage(image, dir.filePath("a.jpg"), &error));
    QCOMPARE(
        Capture::readImage(dir.filePath("a.jpg"), &error).pixelColor(10, 10),
        QColor(Qt::white));
    QVERIFY(!Capture::saveImage(image, dir.filePath("a.bmp"), &error));
    QVERIFY(!Capture::saveImage(image, dir.filePath("missing/a.png"), &error));
    QVERIFY(image.save(dir.filePath("a.webp"), "WEBP"));
    QCOMPARE(Capture::readImage(dir.filePath("a.webp"), &error).size(),
             image.size());
    QVERIFY(image.save(dir.filePath("a.bmp"), "BMP"));
    QCOMPARE(Capture::readImage(dir.filePath("a.bmp"), &error).size(),
             image.size());
    QFile disguised(dir.filePath("wrong.png"));
    QVERIFY(disguised.open(QIODevice::WriteOnly));
    disguised.write(QByteArray::fromBase64(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
    disguised.close();
    QVERIFY(Capture::readImage(dir.filePath("wrong.png"), &error).isNull());
  }
  void effectsAndAnnotationOnlyEraser() {
    Capture::ImageDocument d;
    d.base = QImage(100, 100, QImage::Format_ARGB32);
    d.base.fill(Qt::white);
    {
      QPainter p(&d.base);
      for (int x = 0; x < 100; x += 7)
        p.fillRect(x, 0, 3, 100, Qt::black);
    }
    auto original = d.base;
    d.append({"mosaic", {{10, 10}, {90, 90}}, Qt::red, 4});
    auto fine = d.render();
    d.strokes.last().width = 20;
    auto coarse = d.render();
    QVERIFY(fine != coarse);
    QCOMPARE(d.base, original);
    d.clear();
    d.append({"blur", {{10, 10}, {90, 90}}, Qt::red, 4});
    auto weak = d.render();
    d.strokes.last().width = 20;
    QVERIFY(weak != d.render());
    d.clear();
    d.append({"pen", {{20, 50}, {80, 50}}, Qt::red, 16});
    QCOMPARE(d.render().pixelColor(50, 50), QColor(Qt::red));
    d.append({"eraser", {{50, 20}, {50, 80}}, Qt::black, 20});
    QCOMPARE(d.render().pixelColor(50, 50), original.pixelColor(50, 50));
    QCOMPARE(d.base, original);
    d.undo();
    QCOMPARE(d.render().pixelColor(50, 50), QColor(Qt::red));
    d.redo();
    QCOMPARE(d.render().pixelColor(50, 50), original.pixelColor(50, 50));
    d.clear();
    for (int i = 0; i < 103; ++i)
      d.append({"pen", {{20, 50}, {80, 50}}, Qt::red, 16});
    QVERIFY(!d.archivedLayer.isNull());
    d.append({"eraser", {{50, 20}, {50, 80}}, Qt::black, 20});
    QCOMPARE(d.render().pixelColor(50, 50), original.pixelColor(50, 50));
    d.clear();
    QCOMPARE(d.render(), original);
  }
};
QTEST_MAIN(CoreTest)
#include "core_test.moc"
