#include "ImageDocument.h"
#include <QPainter>
#include <QTemporaryDir>
#include <QtTest>
class CoreTest : public QObject {
  Q_OBJECT
private slots:
  void gaussianHasSmoothSymmetricResponseAndHonorsRegion() {
    Capture::ImageDocument d;
    d.base = QImage(81, 81, QImage::Format_ARGB32_Premultiplied);
    d.base.fill(Qt::black);
    for (int y = 0; y < 81; ++y)
      d.base.setPixelColor(40, y, Qt::white);
    Capture::Stroke blur{"blur", {{8, 8}, {72, 72}}, Qt::black, 6};
    d.append(blur);
    const auto result = d.render();
    // A white line blurred with sigma 2 has the normalized Gaussian profile;
    // nearest-neighbor blocks or downsample/upscale do not satisfy this shape.
    QVERIFY(qAbs(qRed(result.pixel(40, 40)) - 51) <= 1);
    QVERIFY(qAbs(qRed(result.pixel(41, 40)) - 45) <= 1);
    QVERIFY(qAbs(qRed(result.pixel(42, 40)) - 31) <= 1);
    for (int offset = 1; offset <= 6; ++offset) {
      QCOMPARE(result.pixel(40 - offset, 40), result.pixel(40 + offset, 40));
      QVERIFY(qRed(result.pixel(40 + offset - 1, 40)) >
              qRed(result.pixel(40 + offset, 40)));
    }
    QCOMPARE(result.pixelColor(40, 7), QColor(Qt::white));
    QCOMPARE(result.pixelColor(39, 7), QColor(Qt::black));
    d.strokes.last().width = 12;
    QVERIFY(qRed(d.render().pixel(40, 40)) < qRed(result.pixel(40, 40)));
    QCOMPARE(d.base.pixelColor(40, 40), QColor(Qt::white));

    // Sample the image around the region, but never beyond the screenshot's
    // own editable selection. Neither case modifies pixels outside the region.
    d.strokes.last().points = {{42, 10}, {60, 60}};
    d.strokes.last().width = 6;
    QVERIFY(qRed(d.render().pixel(42, 40)) > 0);
    QCOMPARE(d.render().pixelColor(40, 40), QColor(Qt::white));
    d.strokes.last().clipBounds = {42, 10, 19, 51};
    QCOMPARE(d.render().pixelColor(42, 40), QColor(Qt::black));
  }
  void gaussianCacheRetainsHistoryAndExportPixels() {
    Capture::ImageDocument d;
    d.base = QImage(200, 140, QImage::Format_ARGB32_Premultiplied);
    d.base.fill(Qt::white);
    d.append({"line", {{20, 50}, {180, 50}}, Qt::black, 8});
    const auto annotated = d.render();
    d.append({"blur", {{30, 30}, {90, 90}}, Qt::black, 12});
    const auto blurred = d.render();
    QVERIFY(blurred != annotated);
    QVERIFY(d.gaussianWorkingCost(d.strokes.last()) < d.base.sizeInBytes() * 2);
    const auto uncachedBytes = d.memoryCost();
    QVERIFY(d.cacheEffect(d.editable));
    QCOMPARE(d.strokes.last().effectPixels.size(), QSize(61, 61));
    QVERIFY(d.memoryCost() > uncachedBytes);
    QCOMPARE(d.render(), blurred);
    const auto cache = d.strokes.last().effectPixels.cacheKey();
    QCOMPARE(d.render(), blurred);
    QCOMPARE(d.strokes.last().effectPixels.cacheKey(), cache);
    d.undo();
    QCOMPARE(d.render(), annotated);
    d.redo();
    QCOMPARE(d.render(), blurred);
    const QRect selection(40, 35, 90, 75);
    auto pinned = d.cropped(selection);
    QCOMPARE(pinned.render(), blurred.copy(selection));
    QTemporaryDir folder;
    QString error;
    QVERIFY(Capture::saveImage(pinned.render(), folder.filePath("blur.png"), &error));
    QCOMPARE(Capture::readImage(folder.filePath("blur.png"), &error),
             pinned.render().convertToFormat(QImage::Format_ARGB32));
    d.clear();
    QCOMPARE(d.memoryCost(), d.base.sizeInBytes());
  }
  void gaussianPremultipliedEdgesRemainColorCorrect() {
    QImage image(41, 41, QImage::Format_ARGB32_Premultiplied);
    image.fill(Qt::transparent);
    for (int y = 0; y < 41; ++y)
      image.setPixelColor(20, y, Qt::red);
    Capture::ImageDocument::draw(
        image, {"blur", {{5, 5}, {35, 35}}, Qt::black, 6});
    const auto edge = image.pixelColor(22, 20);
    QVERIFY(edge.alpha() > 0 && edge.alpha() < 255);
    QCOMPARE(edge.red(), 255);
    QCOMPARE(edge.green(), 0);
    QCOMPARE(edge.blue(), 0);
    QCOMPARE(image.pixelColor(20, 0), QColor(Qt::red));
  }
  void gaussianDocumentPreservesAlpha() {
    for (auto format : {QImage::Format_ARGB32,
                        QImage::Format_ARGB32_Premultiplied}) {
      Capture::ImageDocument d;
      d.base = QImage(41, 41, format);
      d.base.fill(QColor(255, 0, 0, 128));
      const Capture::Stroke blur{"blur", {{5, 5}, {35, 35}}, Qt::black, 6};
      d.append(blur);
      QCOMPARE(d.render().pixelColor(20, 20), QColor(255, 0, 0, 128));
      QCOMPARE(d.render().pixelColor(2, 2), QColor(255, 0, 0, 128));
      QVERIFY(d.cacheEffect(d.editable));
      QCOMPARE(d.render(), d.base);
      d.append(blur);
      QVERIFY(d.cacheEffect(d.editable));
      QCOMPARE(d.render(), d.base); // Overlapping effects must not add opacity.

      d.clear();
      d.base.fill(Qt::transparent);
      for (int y = 0; y < 41; ++y)
        d.base.setPixelColor(20, y, Qt::red);
      d.append(blur);
      const auto rendered = d.render();
      // The normalized sigma-2 impulse response applies to alpha too. In
      // particular, the original opaque line must no longer show through.
      QVERIFY(qAbs(rendered.pixelColor(20, 20).alpha() - 51) <= 1);
      QVERIFY(qAbs(rendered.pixelColor(22, 20).alpha() - 31) <= 1);
      QCOMPARE(rendered.pixelColor(22, 20).red(), 255);
      QCOMPARE(rendered.pixelColor(20, 0), QColor(Qt::red));
      QCOMPARE(rendered.pixelColor(2, 2).alpha(), 0);
      QVERIFY(d.cacheEffect(d.editable));
      QCOMPARE(d.render(), rendered);
    }
  }
  void transparentEffectsRetainCompositeHistoryAndCrop() {
    Capture::ImageDocument d;
    d.base = QImage(80, 60, QImage::Format_ARGB32_Premultiplied);
    d.base.fill(QColor(255, 0, 0, 128));
    d.append({"pen", {{10, 25}, {70, 25}}, QColor(0, 0, 255, 128), 6});
    const auto annotated = d.render();
    const Capture::Stroke first{"blur", {{12, 10}, {50, 45}}, Qt::black, 6};
    const Capture::Stroke second{"blur", {{30, 12}, {65, 42}}, Qt::black, 9};
    QImage expected = annotated.copy();
    Capture::ImageDocument::draw(expected, first);
    d.append(first);
    QVERIFY(d.cacheEffect(d.editable));
    QCOMPARE(d.render(), expected);
    const auto once = expected;
    Capture::ImageDocument::draw(expected, second);
    d.append(second);
    QVERIFY(d.cacheEffect(d.editable));
    QCOMPARE(d.render(), expected);
    QCOMPARE(d.render(d.editable), once);
    d.undo();
    QCOMPARE(d.render(), once);
    d.redo();
    QCOMPARE(d.render(), expected);

    const QRect area(20, 15, 40, 35);
    auto crop = d.cropped(area);
    QCOMPARE(crop.render(), expected.copy(area));
    crop.undo();
    QCOMPARE(crop.render(), once.copy(area));
    crop.redo();
    QCOMPARE(crop.render(), expected.copy(area));
    QCOMPARE(crop.cropped({5, 5, 25, 20}).render(),
             expected.copy(area).copy(5, 5, 25, 20));
    d.undo();
    auto redoCrop = d.cropped(area);
    redoCrop.redo();
    QCOMPARE(redoCrop.render(), expected.copy(area));
    QTemporaryDir folder;
    QString error;
    QVERIFY(Capture::saveImage(crop.render(), folder.filePath("alpha.png"), &error));
    QCOMPARE(Capture::readImage(folder.filePath("alpha.png"), &error),
             expected.copy(area).convertToFormat(QImage::Format_ARGB32));
    QCOMPARE(d.base.pixelColor(40, 25), QColor(255, 0, 0, 128));
  }
  void transparentEraserRestoresBaseAfterEffectArchival() {
    Capture::ImageDocument d;
    d.base = QImage(80, 60, QImage::Format_ARGB32_Premultiplied);
    d.base.fill(QColor(255, 0, 0, 128));
    for (int y = 30; y < 60; ++y)
      for (int x = 0; x < 80; ++x)
        d.base.setPixelColor(x, y, Qt::transparent);
    d.append({"pen", {{5, 28}, {75, 28}}, Qt::blue, 30});
    d.append({"blur", {{5, 5}, {75, 55}}, Qt::black, 6});
    QVERIFY(d.cacheEffect(d.editable));
    const auto edited = d.render();
    // Move both visible edits past the 100-command undo window, without
    // changing the image. The original transparent pixels remain erasable.
    for (int i = 0; i < 100; ++i)
      d.append({"pen", {{100, 100}, {110, 100}}, Qt::black, 1});
    QVERIFY(!d.archivedLayer.isNull());
    QCOMPARE(d.render(), edited);
    const QRect area(10, 10, 50, 40);
    auto crop = d.cropped(area);
    QCOMPARE(crop.render(), edited.copy(area));
    Capture::Stroke eraser{"eraser", {{30.25, 2}, {30.25, 48}}, Qt::black, 9};
    eraser.clipBounds = {15, 10, 40, 35};
    d.append(eraser);
    const auto erased = d.render();
    QCOMPARE(erased.pixelColor(30, 20), d.base.pixelColor(30, 20));
    QCOMPARE(erased.pixelColor(30, 36).alpha(), 0);
    QCOMPARE(erased.pixelColor(30, 8), edited.pixelColor(30, 8));
    QCOMPARE(erased.pixelColor(45, 20), edited.pixelColor(45, 20));
    const auto edge = erased.pixelColor(25, 20).alpha();
    QVERIFY(edge > d.base.pixelColor(25, 20).alpha());
    QVERIFY(edge < edited.pixelColor(25, 20).alpha());
    QCOMPARE(d.cropped(area).render(), erased.copy(area));
    for (auto &point : eraser.points)
      point -= area.topLeft();
    eraser.clipBounds.translate(-area.topLeft());
    crop.append(eraser);
    QCOMPARE(crop.render(), erased.copy(area));
    crop.undo();
    QCOMPARE(crop.render(), edited.copy(area));
    crop.redo();
    QCOMPARE(crop.render(), erased.copy(area));
    d.undo();
    QCOMPARE(d.render(), edited);
    d.redo();
    QCOMPARE(d.render(), erased);
    d.clear();
    QCOMPARE(d.render(), d.base);
    QCOMPARE(d.memoryCost(), d.base.sizeInBytes());
  }
  void mosaicBrushFollowsPathAndPreservesCrop() {
    Capture::ImageDocument d;
    d.base = QImage(160, 120, QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < 120; ++y)
      for (int x = 0; x < 160; ++x)
        d.base.setPixelColor(x, y,
                             QColor((x * 13 + y * 7) % 256,
                                    (x * 11 + y * 3) % 256,
                                    (x * 3 + y * 17) % 256));
    d.append({"pen", {{10, 20}, {150, 20}}, Qt::red, 8});
    const auto before = d.render();
    Capture::Stroke brush{
        "mosaic", {{30, 30}, {100, 30}, {100, 90}}, Qt::black, 12};
    brush.mosaicBrush = true;
    brush.brushSize = 20;
    brush.clipBounds = {25, 25, 100, 80};
    d.append(brush);
    const auto painted = d.render();
    QVERIFY(painted != before);
    QCOMPARE(painted.pixelColor(60, 60),
             before.pixelColor(60, 60)); // Inside the box, outside the path.
    QCOMPARE(painted.pixelColor(60, 22),
             before.pixelColor(60, 22)); // Brush radius clipped to edit area.
    QVERIFY(painted.pixelColor(60, 30) != before.pixelColor(60, 30));
    QVERIFY(painted.pixelColor(100, 60) != before.pixelColor(100, 60));
    const QRect area(45, 27, 80, 70);
    auto cropped = d.cropped(area);
    QCOMPARE(cropped.render(), painted.copy(area));
    cropped.undo();
    QCOMPARE(cropped.render(), before.copy(area));
    cropped.redo();
    QCOMPARE(cropped.render(), painted.copy(area));
    QCOMPARE(cropped.cropped({5, 5, 50, 50}).render(),
             painted.copy(area).copy(5, 5, 50, 50));
    d.undo();
    auto redoCrop = d.cropped(area);
    redoCrop.redo();
    QCOMPARE(redoCrop.render(), painted.copy(area));
    cropped.append({"eraser", {{10, 3}, {60, 3}}, Qt::black, 20});
    QCOMPARE(cropped.render().pixelColor(20, 3),
             cropped.base.pixelColor(20, 3));
    cropped.undo();
    QCOMPARE(cropped.render(), painted.copy(area));
    d.redo();
    d.strokes.last().points << QPointF(120, 90);
    QCOMPARE(d.render().pixelColor(60, 30),
             painted.pixelColor(60, 30)); // Grid stays put as the path grows.
    QCOMPARE(d.base.pixelColor(60, 60), before.pixelColor(60, 60));
  }
  void mosaicAndEraserSingleClickAreRound() {
    Capture::ImageDocument d;
    d.base = QImage(80, 80, QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < 80; ++y)
      for (int x = 0; x < 80; ++x)
        d.base.setPixelColor(x, y, (x + y) % 2 ? Qt::white : Qt::black);
    Capture::Stroke brush{"mosaic", {{40, 40}, {40, 40}}, Qt::black, 12};
    brush.mosaicBrush = true;
    brush.brushSize = 20;
    d.append(brush);
    const auto painted = d.render();
    QVERIFY(painted.pixelColor(40, 40) != d.base.pixelColor(40, 40));
    QCOMPARE(painted.pixelColor(31, 31), d.base.pixelColor(31, 31));
    d.append({"eraser", {{40, 40}, {40, 40}}, Qt::black, 10});
    QCOMPARE(d.render().pixelColor(40, 40), d.base.pixelColor(40, 40));
    QCOMPARE(d.render().pixelColor(47, 40), painted.pixelColor(47, 40));
  }
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
