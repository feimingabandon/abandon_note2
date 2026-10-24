#include "AnnotationEditor.h"
#include "CaptureAppearance.h"
#include "DesktopCapture.h"
#include "PinWindow.h"
#include <QApplication>
#include <QDir>
#include <QFontDatabase>
#include <QGraphicsScene>
#include <QLineEdit>
#include <QToolButton>
#include <QtTest>
#include <algorithm>

class Canvas : public QWidget {
public:
  Capture::ImageDocument doc;
  AnnotationEditor *editor;
  Canvas() {
    setObjectName("canvas");
    setFocusPolicy(Qt::StrongFocus);
    setMouseTracking(true);
    resize(960, 600);
    doc.base = QImage(960, 600, QImage::Format_ARGB32_Premultiplied);
    doc.base.fill(Qt::white);
    editor = new AnnotationEditor(this, doc);
    connect(editor, &AnnotationEditor::changed, this,
            qOverload<>(&QWidget::update));
    connect(editor, &AnnotationEditor::layoutChanged, this, [this] {
      editor->fitPanel(width() - 40);
      editor->panel->move(20, 450);
    });
    editor->fitPanel(width() - 40);
    editor->panel->move(20, 450);
  }
  void paintEvent(QPaintEvent *) override {
    QPainter p(this);
    p.drawImage(rect(), doc.render(editor->typing() ? doc.editable : -1));
    editor->paintHandles(p);
  }
  void mousePressEvent(QMouseEvent *e) override { editor->press(e); }
  void mouseMoveEvent(QMouseEvent *e) override { editor->move(e); }
  void mouseReleaseEvent(QMouseEvent *e) override { editor->release(e); }
  void keyPressEvent(QKeyEvent *e) override { editor->key(e); }
  void drag(QPointF a, QPointF b,
            Qt::KeyboardModifiers modifiers = Qt::NoModifier) {
    QMouseEvent press(QEvent::MouseButtonPress, a, a, Qt::LeftButton,
                      Qt::LeftButton, modifiers);
    editor->press(&press);
    QMouseEvent move(QEvent::MouseMove, b, b, Qt::NoButton, Qt::LeftButton,
                     modifiers);
    editor->move(&move);
    QMouseEvent release(QEvent::MouseButtonRelease, b, b, Qt::LeftButton,
                        Qt::NoButton, modifiers);
    editor->release(&release);
  }
};
class UxTest : public QObject {
  Q_OBJECT
private slots:
  void init() {
    const QString test = QTest::currentTestFunction();
    if ((test == "frequentToolsHaveFullButtonTargets" ||
         test == "inlineOptionsKeepFocusAndAllowImmediateDrawing" ||
         test == "parameterCompositionDoesNotEscapeToCapture" ||
         test == "roundedToolbarDoesNotExposeBlackCorners") &&
        !Capture::interactiveDesktopAvailable())
      QSKIP("An unlocked interactive Windows desktop is required for focus and "
            "compositor assertions");
  }
  void frequentToolsHaveFullButtonTargets() {
    Canvas c;
    c.show();
    c.activateWindow();
    QVERIFY(QTest::qWaitForWindowActive(&c));
    c.editor->panel->show();
    QVERIFY(!c.editor->action("polyline"));
    for (const auto id : {"rectangle", "ellipse", "arrow", "line", "pen",
                          "marker", "text", "mosaic", "blur", "eraser"}) {
      auto button = c.findChild<QToolButton *>("captureTool_" + QString(id));
      QVERIFY(button);
      QVERIFY(!button->menu());
      QVERIFY(button->width() >= 32 && button->height() >= 30);
      QVERIFY(button->isVisible());
      QTest::mouseClick(button, Qt::LeftButton, Qt::NoModifier,
                        QPoint(2, button->height() / 2));
      QCOMPARE(c.editor->tool, QString(id));
      QVERIFY(button->isChecked());
      QTRY_COMPARE(QApplication::focusWidget(), &c);
    }
    c.editor->choose("line");
    QTest::mouseClick(c.findChild<QToolButton *>("captureTool_arrow"),
                      Qt::LeftButton);
    c.drag({100, 100}, {200, 200});
    QCOMPARE(c.doc.strokes.last().tool, QString("arrow"));
  }
  void inlineOptionsKeepFocusAndAllowImmediateDrawing() {
    Canvas c;
    c.show();
    c.activateWindow();
    QVERIFY(QTest::qWaitForWindowActive(&c));
    c.editor->panel->show();
    c.editor->choose("pen");
    auto options = c.findChild<QScrollArea *>("annotationOptions");
    QVERIFY(options->isVisible());
    QVERIFY(!c.findChild<QToolButton *>("captureParameters"));
    auto size = c.findChild<QSpinBox *>("annotationSize");
    size->setFocus();
    size->selectAll();
    QTest::keyClicks(size, "23");
    QCOMPARE(size->value(), 23);
    QCOMPARE(QApplication::focusWidget(), size);
    QTest::mouseClick(
        c.editor->panel, Qt::LeftButton, Qt::NoModifier,
        QPoint(c.editor->panel->width() - 2, c.editor->panel->height() / 2));
    QVERIFY(c.doc.strokes.isEmpty());
    QTest::keyClick(size, Qt::Key_Return);
    QTRY_COMPARE(QApplication::focusWidget(), &c);
    c.drag({200, 200}, {300, 300});
    QCOMPARE(c.doc.strokes.size(), 1);
    QCOMPARE(c.doc.strokes.last().width, 23);
    QVERIFY(options->isVisible());
  }
  void parameterCompositionDoesNotEscapeToCapture_data() {
    QTest::addColumn<bool>("innerEditor");
    QTest::addColumn<int>("key");
    QTest::newRow("font-escape") << false << int(Qt::Key_Escape);
    QTest::newRow("inner-escape") << true << int(Qt::Key_Escape);
    QTest::newRow("font-enter") << false << int(Qt::Key_Return);
    QTest::newRow("inner-enter") << true << int(Qt::Key_Return);
  }
  void parameterCompositionDoesNotEscapeToCapture() {
    QFETCH(bool, innerEditor);
    QFETCH(int, key);
    Canvas c;
    c.show();
    c.activateWindow();
    QVERIFY(QTest::qWaitForWindowActive(&c));
    c.editor->panel->show();
    c.editor->choose("text");
    auto options = c.findChild<QScrollArea *>("annotationOptions");
    auto font = c.findChild<QFontComboBox *>("annotationFont");
    auto editor = font->lineEdit();
    QVERIFY(editor);
    font->setFocus();
    QTRY_VERIFY(QApplication::focusWidget() == font ||
                font->isAncestorOf(QApplication::focusWidget()));
    auto keyboardTarget = QApplication::focusWidget();
    auto inputTarget = innerEditor ? static_cast<QWidget *>(editor)
                                   : static_cast<QWidget *>(font);
    QInputMethodEvent preedit(QStringLiteral("微"), {});
    QApplication::sendEvent(inputTarget, &preedit);
    // Keys must go to Qt's actual focus owner, including when the preedit
    // event arrived through the font combo's internal editor.
    QTest::keyClick(keyboardTarget, Qt::Key(key));
    QVERIFY(options->isVisible());
    QCOMPARE(QApplication::focusWidget(), keyboardTarget);
    QInputMethodEvent ended;
    QApplication::sendEvent(inputTarget, &ended);
    QTest::keyClick(keyboardTarget, Qt::Key_Escape);
    QTRY_COMPARE(QApplication::focusWidget(), &c);
    QVERIFY(c.doc.strokes.isEmpty());
  }
  void roundedToolbarDoesNotExposeBlackCorners() {
    Canvas c;
    const QColor backdrop("#2d9463");
    c.doc.base.fill(backdrop);
    c.setWindowFlag(Qt::WindowStaysOnTopHint);
    c.show();
    c.activateWindow();
    QVERIFY(QTest::qWaitForWindowActive(&c));
    c.editor->panel->show();
    auto panel = c.editor->panel;
    for (const auto tool : {"select", "arrow", "text", "mosaic"}) {
      c.editor->choose(tool);
      QApplication::processEvents();
      const auto composite = c.grab().toImage();
      for (const auto corner :
           {panel->rect().topLeft(), panel->rect().topRight(),
            panel->rect().bottomLeft(), panel->rect().bottomRight()}) {
        QVERIFY(!panel->mask().contains(corner));
        const auto at = panel->mapTo(&c, corner);
        QCOMPARE(composite.pixelColor(at), backdrop);
      }
    }
    // Pin editing promotes this same panel to an owned native tool window.
    panel->setWindowFlags(Qt::Tool | Qt::FramelessWindowHint |
                          Qt::WindowStaysOnTopHint);
    panel->move(c.mapToGlobal(QPoint(80, 180)));
    panel->show();
    QTest::qWait(50);
    const auto origin = panel->mapToGlobal(QPoint());
    const auto native = c.screen()->grabWindow(0, origin.x(), origin.y(),
                                               panel->width(), panel->height());
    QVERIFY(!native.isNull());
    const auto pixels = native.toImage();
    for (const auto corner :
         {pixels.rect().topLeft(), pixels.rect().topRight(),
          pixels.rect().bottomLeft(), pixels.rect().bottomRight()})
      QCOMPARE(pixels.pixelColor(corner), backdrop);
    const auto evidence = qEnvironmentVariable("CAPTURE_UX_EVIDENCE");
    if (!evidence.isEmpty()) {
      QDir().mkpath(evidence);
      QVERIFY(
          native.save(QDir(evidence).filePath("native-toolbar-corners.png")));
    }
    panel->hide();
  }
  void annotationControlsFollowTool_data() {
    QTest::addColumn<QString>("tool");
    for (auto tool : {"rectangle", "ellipse", "line", "arrow", "pen", "marker",
                      "mosaic", "blur", "eraser"})
      QTest::newRow(tool) << QString(tool);
  }
  void annotationControlsFollowTool() {
    QFETCH(QString, tool);
    Canvas c;
    c.editor->choose(tool);
    c.drag({100, 100}, {300, 220});
    QVERIFY(c.editor->hasCurrent());
    const auto exported = c.doc.render();
    const auto bounds = c.doc.strokes.last().bounds();
    QEvent leave(QEvent::Leave);
    QApplication::sendEvent(&c, &leave);
    QImage chrome(c.size(), QImage::Format_ARGB32_Premultiplied);
    chrome.fill(Qt::transparent);
    {
      QPainter painter(&chrome);
      c.editor->paintHandles(painter);
    }
    QImage empty(chrome.size(), chrome.format());
    empty.fill(Qt::transparent);
    QCOMPARE(chrome, empty); // No controls immediately after drawing.
    QMouseEvent hover(QEvent::MouseMove, QPointF(100, 100), QPointF(100, 100),
                      Qt::NoButton, Qt::NoButton, Qt::NoModifier);
    if (tool != "polyline")
      c.editor->move(&hover);
    // Hide only the pointer guide, then hover a non-brush object's handle.
    const bool noHandles = tool == "pen" || tool == "marker" ||
                           tool == "mosaic" || tool == "blur" || tool == "eraser" ||
                           tool == "polyline";
    if (noHandles)
      QApplication::sendEvent(&c, &leave);
    chrome.fill(Qt::transparent);
    {
      QPainter painter(&chrome);
      c.editor->paintHandles(painter);
    }
    const QVector<QPointF> corners =
        tool == "line" || tool == "arrow"
            ? QVector<QPointF>{{100, 100}, {300, 220}}
            : QVector<QPointF>{bounds.topLeft(), bounds.topRight(),
                               bounds.bottomLeft(), bounds.bottomRight()};
    int visiblePixels = 0;
    for (int y = 0; y < chrome.height(); ++y)
      for (int x = 0; x < chrome.width(); ++x) {
        if (!qAlpha(chrome.pixel(x, y)))
          continue;
        ++visiblePixels;
        QVERIFY2(
            std::any_of(corners.begin(), corners.end(),
                        [&](auto corner) {
                          return QRectF(corner - QPointF(4, 4), QSizeF(8, 8))
                              .contains(QPointF(x, y));
                        }),
            "Annotation chrome must be limited to handles, without a frame");
      }
    QCOMPARE(visiblePixels > 0, !noHandles);
    QVERIFY(c.editor->hasCurrent());
    QCOMPARE(c.doc.render(), exported);
    c.editor->complete();
    chrome.fill(Qt::transparent);
    {
      QPainter painter(&chrome);
      c.editor->paintHandles(painter);
    }
    QCOMPARE(chrome, empty);
    QCOMPARE(c.doc.render(), exported);
  }
  void parametersKeepFocusAndValues() {
    Canvas c;
    c.show();
    c.activateWindow();
    c.editor->panel->show();
    c.editor->choose("rectangle");
    QVERIFY(c.findChild<QScrollArea *>("annotationOptions")->isVisible());
    auto size = c.findChild<QSpinBox *>("annotationSize");
    size->setFocus();
    size->selectAll();
    QApplication::processEvents();
    QCOMPARE(QApplication::focusWidget(), size);
    QTest::keyClick(QApplication::focusWidget(), Qt::Key_2);
    QCOMPARE(QApplication::focusWidget(), size);
    QTest::keyClick(QApplication::focusWidget(), Qt::Key_4);
    QCOMPARE(size->value(), 24);
    QTest::keyClick(QApplication::focusWidget(), Qt::Key_Return);
    QTRY_COMPARE(QApplication::focusWidget(), &c);
    c.editor->choose("ellipse");
    c.editor->choose("rectangle");
    QCOMPARE(size->value(), 24);
    c.editor->choose("eraser");
    size->setValue(35);
    c.editor->choose("text");
    c.editor->choose("eraser");
    QCOMPARE(size->value(), 35);
  }
  void continuousStrokes() {
    for (QString tool : {"pen", "marker", "eraser", "mosaic"}) {
      Canvas c;
      c.editor->choose(tool);
      c.drag({100, 100}, {200, 200});
      const auto points = c.doc.strokes.first().points;
      c.drag({150, 150}, {240, 150});
      QCOMPARE(c.doc.strokes.size(), 2);
      QCOMPARE(c.doc.strokes.first().points, points);
      c.doc.undo();
      c.doc.redo();
      QCOMPARE(c.doc.strokes.size(), 2);
    }
  }
  void mosaicParametersAndRegionMode() {
    Canvas c;
    c.show();
    c.editor->panel->show();
    c.editor->choose("mosaic");
    QVERIFY(c.editor->action("blur"));
    auto mode = c.findChild<QComboBox *>("annotationMosaicMode");
    auto brush = c.findChild<QSpinBox *>("annotationSize");
    auto block = c.findChild<QSpinBox *>("annotationMosaicBlock");
    auto options = c.findChild<QScrollArea *>("annotationOptions");
    QApplication::processEvents();
    for (auto field :
         {static_cast<QWidget *>(mode), static_cast<QWidget *>(brush),
          static_cast<QWidget *>(block)}) {
      QVERIFY(field->isVisible());
      QVERIFY(options->rect().contains(
          QRect(field->mapTo(options, QPoint()), field->size())));
    }
    c.editor->closePopovers();
    QCOMPARE(mode->currentData().toString(), QString("brush"));
    brush->setValue(40);
    block->setValue(8);
    c.drag({100, 100}, {200, 150});
    QVERIFY(c.doc.strokes.last().mosaicBrush);
    QCOMPARE(c.doc.strokes.last().brushSize, 40);
    QCOMPARE(c.doc.strokes.last().width, 8);
    const auto points = c.doc.strokes.last().points;
    block->setValue(20);
    QCOMPARE(c.doc.strokes.last().brushSize, 40);
    QCOMPARE(c.doc.strokes.last().points, points);
    mode->setCurrentIndex(1);
    c.drag({100, 100}, {200, 150});
    QCOMPARE(c.doc.strokes.size(), 2);
    QVERIFY(!c.doc.strokes.last().mosaicBrush);
    mode->setCurrentIndex(0);
    c.drag({100, 100}, {200, 150});
    QCOMPARE(c.doc.strokes.size(), 3);
    QVERIFY(c.doc.strokes.last().mosaicBrush);
  }
  void gaussianRegionGestureStrengthHistoryAndMovement() {
    Canvas c;
    {
      QPainter p(&c.doc.base);
      for (int x = 0; x < 960; x += 13)
        p.fillRect(x, 0, 4, 600, Qt::black);
    }
    c.editor->choose("blur");
    QCOMPARE(c.editor->tool, QString("blur"));
    auto strength = c.findChild<QSpinBox *>("annotationSize");
    QCOMPARE(strength->maximum(), 32);
    QCOMPARE(strength->accessibleName(), QStringLiteral("高斯模糊强度"));
    QVERIFY(!c.findChild<QComboBox *>("annotationMosaicMode")->isVisible());
    strength->setValue(6);
    QMouseEvent press(QEvent::MouseButtonPress, QPointF(100, 100), QPointF(100, 100),
                       Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
    QMouseEvent move(QEvent::MouseMove, QPointF(300, 250), QPointF(300, 250),
                      Qt::NoButton, Qt::LeftButton, Qt::NoModifier);
    c.editor->press(&press);
    c.editor->move(&move);
    QVERIFY(c.doc.strokes.last().effectDraft);
    QCOMPARE(c.doc.render(), c.doc.base); // Dragging does not repeatedly convolve.
    QImage guide(c.size(), QImage::Format_ARGB32_Premultiplied);
    guide.fill(Qt::transparent);
    const auto empty = guide.copy();
    {
      QPainter p(&guide);
      c.editor->paintHandles(p);
    }
    QVERIFY(guide != empty);
    QMouseEvent release(QEvent::MouseButtonRelease, QPointF(300, 250), QPointF(300, 250),
                         Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
    c.editor->release(&release);
    QVERIFY(!c.doc.strokes.last().effectDraft);
    QVERIFY(!c.doc.strokes.last().effectPixels.isNull());
    const auto weak = c.doc.render();
    QVERIFY(weak != c.doc.base);
    const auto weakCache = c.doc.strokes.last().effectPixels.cacheKey();
    strength->setValue(20);
    const auto strong = c.doc.render();
    QVERIFY(strong != weak);
    QVERIFY(c.doc.strokes.last().effectPixels.cacheKey() != weakCache);
    c.editor->action("undo")->trigger();
    QCOMPARE(c.doc.render(), c.doc.base);
    c.editor->action("redo")->trigger();
    QCOMPARE(c.doc.render(), strong);
    c.drag({150, 150}, {350, 260}); // Overlapping regions remain independent edits.
    QCOMPARE(c.doc.strokes.size(), 2);
    const auto points = c.doc.strokes.last().points;
    c.drag({200, 180}, {220, 190}, Qt::AltModifier);
    QCOMPARE(c.doc.strokes.size(), 2);
    QCOMPARE(c.doc.strokes.last().points.first(), points.first() + QPointF(20, 10));
    QVERIFY(!c.doc.strokes.last().effectPixels.isNull());
    QVERIFY(c.editor->complete());
    c.editor->choose("mosaic");
    QCOMPARE(strength->maximum(), 200);
    QCOMPARE(c.editor->tool, QString("mosaic"));
  }
  void gaussianFailedFinalizationCanRetryUndoOrCancel() {
    Canvas c;
    c.editor->choose("blur");
    QSignalSpy notices(c.editor, &AnnotationEditor::notice);
    QMouseEvent press(QEvent::MouseButtonPress, QPointF(100, 100), QPointF(100, 100),
                       Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
    QMouseEvent move(QEvent::MouseMove, QPointF(300, 250), QPointF(300, 250),
                      Qt::NoButton, Qt::LeftButton, Qt::NoModifier);
    c.editor->press(&press);
    c.editor->move(&move);
    c.editor->allowAllocation = [](qint64) { return false; };
    QMouseEvent release(QEvent::MouseButtonRelease, QPointF(300, 250), QPointF(300, 250),
                         Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
    c.editor->release(&release);
    QVERIFY(c.doc.strokes.last().effectDraft);
    QVERIFY(!c.editor->complete());
    QVERIFY(!notices.isEmpty());
    c.editor->choose("mosaic");
    QCOMPARE(c.editor->tool, QString("blur"));
    c.editor->action("undo")->trigger();
    QVERIFY(c.doc.strokes.isEmpty());
    c.editor->allowAllocation = [](qint64) { return true; };
    c.editor->action("redo")->trigger();
    QVERIFY(!c.doc.strokes.last().effectDraft);
    QVERIFY(!c.doc.strokes.last().effectPixels.isNull());
    const auto retained = c.doc.strokes.last().effectPixels;
    const auto previousWidth = c.doc.strokes.last().width;
    c.editor->allowAllocation = [](qint64) { return false; };
    c.findChild<QSpinBox *>("annotationSize")->setValue(previousWidth + 1);
    QCOMPARE(c.doc.strokes.last().effectPixels, retained);
    QCOMPARE(c.findChild<QSpinBox *>("annotationSize")->value(), previousWidth);
    QTest::keyClick(&c, Qt::Key_Escape);
    QVERIFY(c.doc.strokes.isEmpty());
    QVERIFY(c.editor->complete());
  }
  void gaussianPinExportRejectsUnfinishedEffect() {
    Capture::ImageDocument document;
    document.base = QImage(120, 100, QImage::Format_ARGB32_Premultiplied);
    document.base.fill(Qt::white);
    document.append({"line", {{5, 50}, {110, 50}}, Qt::black, 8});
    // Pin construction completes the supplied document. Create the pending
    // effect afterwards so this exercises export finalization, not construction.
    PinWindow pin(document);
    Capture::Stroke blur{"blur", {{10, 10}, {100, 90}}, Qt::black, 12};
    blur.effectDraft = true;
    pin.document.append(blur);
    pin.annotations->allowAllocation = [](qint64) { return false; };
    pin.annotations->sync();
    QCOMPARE(pin.document.editable, 1);
    QVERIFY(pin.document.strokes.last().effectDraft);
    QVERIFY(pin.document.strokes.last().effectPixels.isNull());
    QVERIFY(pin.exportImage().isNull());
    QVERIFY(pin.document.strokes.last().effectDraft);
    pin.annotations->allowAllocation = [](qint64) { return true; };
    const auto output = pin.exportImage();
    QVERIFY(!output.isNull());
    QVERIFY(!pin.document.strokes.last().effectDraft);
    blur.effectDraft = false;
    document.append(blur);
    QCOMPARE(output, document.render());
  }
  void lineEndpointsAndAccurateHit() {
    Canvas c;
    c.editor->choose("arrow");
    c.drag({100, 100}, {300, 220});
    c.drag({300, 220}, {300, 100});
    QCOMPARE(c.doc.strokes.size(), 1);
    QCOMPARE(c.doc.strokes.first().points.first(), QPointF(100, 100));
    QCOMPARE(c.doc.strokes.first().points.last(), QPointF(300, 100));
    c.drag({300, 100}, {100, 220}); // Reverse direction without scaling a box.
    QCOMPARE(c.doc.strokes.first().points.last(), QPointF(100, 220));
    c.drag({200, 170}, {400, 170}); // Empty space next to vertical arrow.
    QCOMPARE(c.doc.strokes.size(), 2);
    c.editor->choose("ellipse");
    c.drag({100, 100}, {300, 220});
    c.drag({200, 160}, {400, 300}); // Interior does not steal the next ellipse.
    QCOMPARE(c.doc.strokes.size(), 4);
  }
  void circularBrushGuideIsDisplayOnly_data() {
    QTest::addColumn<QString>("tool");
    for (auto tool : {"mosaic", "eraser"})
      QTest::newRow(tool) << QString(tool);
  }
  void circularBrushGuideIsDisplayOnly() {
    QFETCH(QString, tool);
    Canvas c;
    c.editor->choose(tool);
    c.findChild<QSpinBox *>("annotationSize")->setValue(40);
    const auto exported = c.doc.render();
    QMouseEvent hover(QEvent::MouseMove, QPointF(200, 200), QPointF(200, 200),
                      Qt::NoButton, Qt::NoButton, Qt::NoModifier);
    c.editor->move(&hover);
    QCOMPARE(c.cursor().shape(), Qt::BlankCursor);
    QCOMPARE(c.editor->panel->cursor().shape(), Qt::ArrowCursor);
    QImage guide(c.size(), QImage::Format_ARGB32_Premultiplied);
    guide.fill(Qt::transparent);
    {
      QPainter p(&guide);
      c.editor->paintHandles(p);
    }
    QVERIFY(qAlpha(guide.pixel(200, 180)) > 0);
    QVERIFY(qAlpha(guide.pixel(180, 200)) > 0);
    QCOMPARE(qAlpha(guide.pixel(180, 180)), 0); // Circle, not a square.
    QCOMPARE(qAlpha(guide.pixel(200, 200)), 0);
    QCOMPARE(c.doc.render(), exported);
    QEvent leave(QEvent::Leave);
    QApplication::sendEvent(&c, &leave);
    QCOMPARE(c.cursor().shape(), Qt::CrossCursor);
    guide.fill(Qt::transparent);
    {
      QPainter p(&guide);
      c.editor->paintHandles(p);
    }
    QImage empty(guide.size(), guide.format());
    empty.fill(Qt::transparent);
    QCOMPARE(guide, empty);
  }
  void brushGuideTracksImageTransformAndEditBounds() {
    Canvas c;
    c.editor->viewportTransform = [] {
      QTransform t;
      t.translate(50, 30);
      t.scale(.5, .5);
      return t;
    };
    c.editor->editBounds = {100, 100, 400, 300};
    c.editor->choose("eraser");
    c.findChild<QSpinBox *>("annotationSize")->setValue(40);
    QMouseEvent hover(QEvent::MouseMove, QPointF(150, 130), QPointF(150, 130),
                      Qt::NoButton, Qt::NoButton, Qt::NoModifier);
    c.editor->move(&hover);
    QImage guide(c.size(), QImage::Format_ARGB32_Premultiplied);
    guide.fill(Qt::transparent);
    {
      QPainter p(&guide);
      c.editor->paintHandles(p);
    }
    QVERIFY(qAlpha(guide.pixel(150, 120)) >
            0); // 40 image pixels -> 20 display pixels.
    QCOMPARE(qAlpha(guide.pixel(150, 110)), 0);
    c.drag({150, 130}, {400, 300});
    QCOMPARE(
        c.cursor().shape(),
        Qt::CrossCursor); // No invisible pointer outside the editable region.
    QCOMPARE(c.doc.strokes.last().points.last(), QPointF(500, 400));
  }
  void textHandlesAndRotatedHit() {
    Canvas c;
    c.doc.append(
        {"text", {{100, 100}, {200, 150}}, Qt::black, 3, 24, "Example"});
    c.editor->sync();
    c.drag({200, 150}, {300, 200});
    QCOMPARE(c.doc.strokes.last().fontSize, 48);
    QCOMPARE(c.doc.strokes.last().bounds(), QRectF(100, 100, 200, 100));
    c.drag({200, 76}, {274, 150});
    QVERIFY(qAbs(c.doc.strokes.last().rotation - 90) < .01);
    auto &stroke = c.doc.strokes.last();
    auto point = stroke.localTransform().map(stroke.bounds().topLeft() +
                                             QPointF(40, 20));
    const auto before = stroke.points.first();
    c.drag(point, point + QPointF(12, 7));
    QCOMPARE(c.doc.strokes.size(), 1);
    QCOMPARE(c.doc.strokes.last().points.first(), before + QPointF(12, 7));
  }
  void textInputTransformsWithDocument() {
    Canvas c;
    c.doc.base.fill(QColor("#fff2c6"));
    c.show();
    c.editor->choose("text");
    QTest::mouseClick(&c, Qt::LeftButton, Qt::NoModifier, {180, 180});
    auto text = c.editor->textWidget();
    QVERIFY(text);
    text->setPlainText(QStringLiteral("中文第一行\nSecond line"));
    c.findChild<QSpinBox *>("annotationRotation")->setValue(45);
    auto view = c.findChild<QGraphicsView *>("annotationTextView");
    QVERIFY(view);
    auto proxy = qgraphicsitem_cast<QGraphicsProxyWidget *>(
        view->scene()->items().first());
    QVERIFY(proxy);
    QCOMPARE(proxy->rotation(), 45.);
    QCOMPARE(text->font().pixelSize(), 24);
    const auto evidence = qEnvironmentVariable("CAPTURE_UX_EVIDENCE");
    if (!evidence.isEmpty()) {
      QVERIFY(QDir().mkpath(evidence));
      QApplication::processEvents();
      QVERIFY(c.grab().save(QDir(evidence).filePath("text-input.png")));
    }
    const auto expected = c.doc.render();
    QTest::keyClick(text, Qt::Key_Return, Qt::ControlModifier);
    QVERIFY(!c.editor->typing());
    QCOMPARE(c.doc.render(), expected);
    if (!evidence.isEmpty()) {
      QApplication::processEvents();
      QVERIFY(c.grab().save(QDir(evidence).filePath("text-committed.png")));
    }
  }
  void keyboardEditsCurrentObject() {
    Canvas c;
    c.show();
    c.activateWindow();
    c.editor->panel->show();
    c.editor->choose("line");
    c.drag({100, 100}, {200, 150});
    c.setFocus();
    QApplication::processEvents();
    QCOMPARE(QApplication::focusWidget(), &c);
    QTest::keyClick(QApplication::focusWidget(), Qt::Key_Tab);
    QCOMPARE(c.doc.strokes.last().tool, QString("arrow"));
    QTest::keyClick(&c, Qt::Key_Right);
    QCOMPARE(c.doc.strokes.last().points.first(), QPointF(101, 100));
    QTest::keyClick(&c, Qt::Key_Escape);
    QVERIFY(c.doc.strokes.isEmpty());
    auto rectangle = c.findChild<QToolButton *>("captureTool_rectangle");
    QVERIFY(rectangle);
    rectangle->setFocus();
    QTest::keyClick(rectangle, Qt::Key_Space);
    QCOMPARE(c.editor->tool, QString("rectangle"));
  }
  void textRightClickCommitsAndMenuKeepsKeys() {
    Canvas c;
    c.show();
    c.editor->panel->show();
    c.editor->choose("text");
    QTest::mouseClick(&c, Qt::LeftButton, Qt::NoModifier, {180, 180});
    auto text = c.editor->textWidget();
    QVERIFY(text);
    text->setPlainText(QStringLiteral("保留文字"));
    QTest::mouseClick(text->viewport(), Qt::RightButton, Qt::NoModifier,
                      {10, 10});
    QVERIFY(!c.editor->typing());
    QVERIFY(!c.editor->hasCurrent());
    QCOMPARE(c.doc.strokes.last().text, QStringLiteral("保留文字"));
    auto menu = c.editor->panel->findChild<QMenu *>();
    QVERIFY(menu);
    auto first = menu->addAction("First");
    auto second = menu->addAction("Second");
    menu->popup({10, 10});
    menu->setActiveAction(first);
    QTest::keyClick(menu, Qt::Key_Down);
    QCOMPARE(menu->activeAction(), second);
    menu->close();
  }
  void editedCroppedEffectResamples() {
    Canvas c;
    for (int x = 0; x < c.doc.base.width(); x += 7) {
      QPainter p(&c.doc.base);
      p.fillRect(x, 0, 3, 600, Qt::black);
    }
    c.doc.append({"mosaic", {{20, 20}, {140, 100}}, Qt::black, 12});
    c.doc = c.doc.cropped({45, 30, 80, 70});
    c.editor->editBounds = c.doc.base.rect();
    c.editor->sync();
    QVERIFY(!c.doc.strokes.last().effectPixels.isNull());
    c.findChild<QSpinBox *>("annotationSize")->setValue(20);
    QVERIFY(c.doc.strokes.last().effectPixels.isNull());
    c.editor->complete();
    QVERIFY(!c.doc.render().isNull());
  }
  void toolbarLayoutAndTheme() {
    Canvas c;
    c.show();
    c.editor->panel->show();
    c.editor->choose("arrow");
    const auto strokeCount = c.doc.strokes.size();
    QTest::mouseClick(
        c.editor->panel, Qt::LeftButton, Qt::NoModifier,
        {c.editor->panel->width() - 10, c.editor->panel->height() - 10});
    QCOMPARE(c.doc.strokes.size(), strokeCount);
    c.editor->fitPanel(240);
    QApplication::processEvents();
    QVERIFY(c.editor->panel->width() <= 240);
    for (auto id : {"pin", "save", "cancel", "copy"}) {
      auto button = c.editor->outputs->widgetForAction(c.editor->action(id));
      QVERIFY2(button && button->isVisible(), id);
      QVERIFY(c.editor->panel->rect().contains(
          QRect(button->mapTo(c.editor->panel, QPoint()), button->size())));
    }
    Capture::applyTheme({{"background", "#111820"}, {"foreground", "#eff5ff"}});
    QCOMPARE(qApp->palette().window().color(), QColor("#111820"));
    auto icon = Capture::actionIcon("arrow");
    auto high = icon.pixmap(QSize(20, 20), 2.0);
    QCOMPARE(high.size(), QSize(40, 40));
    Capture::applyTheme({});
  }
  void syntheticVisualEvidence() {
    const auto output = qEnvironmentVariable("CAPTURE_UX_EVIDENCE");
    if (output.isEmpty())
      QSKIP("Set CAPTURE_UX_EVIDENCE to export synthetic previews");
    QDir().mkpath(output);
    for (auto theme : {"light", "dark", "complex"}) {
      Canvas c;
      if (QString(theme) == "dark") {
        c.doc.base.fill(Qt::black);
        Capture::applyTheme(
            {{"background", "#111820"}, {"foreground", "#eff5ff"}});
      } else
        Capture::applyTheme({});
      if (QString(theme) == "complex") {
        QPainter p(&c.doc.base);
        for (int y = 0; y < 600; y += 40)
          for (int x = 0; x < 960; x += 40)
            p.fillRect(x, y, 40, 40, QColor::fromHsv((x + y) % 360, 130, 180));
      }
      c.editor->choose("arrow");
      c.drag({240, 120}, {440, 280});
      c.editor->complete();
      c.show();
      c.editor->panel->show();
      QApplication::processEvents();
      QVERIFY(c.grab().save(QDir(output).filePath(QString(theme) + ".png")));
      QVERIFY(c.editor->panel->grab().save(
          QDir(output).filePath(QString("toolbar-") + theme + ".png")));
      // Preserve the actual surrounding canvas pixels in the preview. A raw
      // transparent widget grab alone cannot prove how its corners composite.
      QVERIFY(c.grab(c.editor->panel->geometry().adjusted(-8, -8, 8, 8))
                  .save(QDir(output).filePath(QString("toolbar-composite-") +
                                              theme + ".png")));
      {
        QPainter p(&c.doc.base);
        for (int y = 70; y < 400; y += 5)
          for (int x = 100; x < 700; x += 5)
            p.fillRect(x, y, 5, 5,
                       QColor::fromHsv((x * 3 + y) % 360, 180,
                                       (x + y) % 10 ? 180 : 240));
      }
      c.editor->choose("mosaic");
      c.findChild<QSpinBox *>("annotationSize")->setValue(60);
      c.drag({180, 180}, {500, 180});
      QMouseEvent hover(QEvent::MouseMove, QPointF(500, 180), QPointF(500, 180),
                        Qt::NoButton, Qt::NoButton, Qt::NoModifier);
      c.editor->move(&hover);
      QApplication::processEvents();
      QVERIFY(c.grab().save(
          QDir(output).filePath(QString("mosaic-") + theme + ".png")));
      QVERIFY(c.findChild<QScrollArea *>("annotationOptions")
                  ->grab()
                  .save(QDir(output).filePath(QString("parameters-mosaic-") +
                                              theme + ".png")));
      c.editor->closePopovers();
      c.editor->choose("blur");
      c.findChild<QSpinBox *>("annotationSize")->setValue(18);
      c.drag({180, 270}, {500, 370});
      QApplication::processEvents();
      QVERIFY(c.grab().save(
          QDir(output).filePath(QString("gaussian-") + theme + ".png")));
      QVERIFY(c.findChild<QScrollArea *>("annotationOptions")
                  ->grab()
                  .save(QDir(output).filePath(QString("parameters-gaussian-") +
                                              theme + ".png")));
      c.editor->choose("eraser");
      c.findChild<QSpinBox *>("annotationSize")->setValue(40);
      c.drag({350, 130}, {350, 230});
      QMouseEvent eraserHover(QEvent::MouseMove, QPointF(350, 230),
                              QPointF(350, 230), Qt::NoButton, Qt::NoButton,
                              Qt::NoModifier);
      c.editor->move(&eraserHover);
      QApplication::processEvents();
      QVERIFY(c.grab().save(
          QDir(output).filePath(QString("eraser-") + theme + ".png")));
      c.editor->choose("text");
      QVERIFY(c.findChild<QScrollArea *>("annotationOptions")
                  ->grab()
                  .save(QDir(output).filePath(QString("parameters-text-") +
                                              theme + ".png")));
      c.editor->closePopovers();
      auto more = c.findChild<QToolButton *>("captureMore");
      more->menu()->popup(more->mapToGlobal(QPoint(0, more->height())));
      QTest::qWait(30);
      QVERIFY(more->menu()->grab().save(
          QDir(output).filePath(QString("menu-more-") + theme + ".png")));
      c.editor->closePopovers();
    }
    Capture::applyTheme({});
  }
};
int main(int argc, char **argv) {
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  QFontDatabase::addApplicationFont("C:/Windows/Fonts/msyh.ttc");
  QFontDatabase::addApplicationFont("C:/Windows/Fonts/segoeui.ttf");
  app.setFont(QFont("Microsoft YaHei", 9));
  app.setQuitOnLastWindowClosed(false);
  Capture::applyTheme({});
  UxTest test;
  return QTest::qExec(&test, argc, argv);
}
#include "ux_test.moc"
