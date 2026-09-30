#include "AnnotationEditor.h"
#include "CaptureAppearance.h"
#include <QApplication>
#include <QDir>
#include <QFontDatabase>
#include <QGraphicsScene>
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
  void annotationHandlesHaveNoBoundingFrame_data() {
    QTest::addColumn<QString>("tool");
    for (auto tool : {"rectangle", "ellipse", "line", "polyline", "arrow",
                      "pen", "marker", "mosaic", "blur", "eraser"})
      QTest::newRow(tool) << QString(tool);
  }
  void annotationHandlesHaveNoBoundingFrame() {
    QFETCH(QString, tool);
    Canvas c;
    c.editor->choose(tool);
    c.drag({100, 100}, {300, 220});
    QVERIFY(c.editor->hasCurrent());
    const auto exported = c.doc.render();
    const auto bounds = c.doc.strokes.last().bounds();
    QImage chrome(c.size(), QImage::Format_ARGB32_Premultiplied);
    chrome.fill(Qt::transparent);
    {
      QPainter painter(&chrome);
      c.editor->paintHandles(painter);
    }
    const QVector<QPointF> corners{bounds.topLeft(), bounds.topRight(),
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
    QVERIFY(visiblePixels > 0);
    QVERIFY(c.editor->hasCurrent());
    QCOMPARE(c.doc.render(), exported);
    c.editor->complete();
    chrome.fill(Qt::transparent);
    {
      QPainter painter(&chrome);
      c.editor->paintHandles(painter);
    }
    QImage empty(chrome.size(), chrome.format());
    empty.fill(Qt::transparent);
    QCOMPARE(chrome, empty);
    QCOMPARE(c.doc.render(), exported);
  }
  void parametersKeepFocusAndValues() {
    Canvas c;
    c.show();
    c.activateWindow();
    c.editor->panel->show();
    c.editor->choose("rectangle");
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
    QCOMPARE(QApplication::focusWidget(), &c);
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
    for (QString tool : {"pen", "marker", "eraser"}) {
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
    auto rectangle = qobject_cast<QToolButton *>(
        c.editor->toolbar->widgetForAction(c.editor->action("rectangle")));
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
        c.doc.base.fill(QColor("#111820"));
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
