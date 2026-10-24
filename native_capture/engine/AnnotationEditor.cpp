#include "AnnotationEditor.h"
#include "CaptureAppearance.h"
#include <QApplication>
#include <QColorDialog>
#include <QGraphicsScene>
#include <QGuiApplication>
#include <QInputMethod>
#include <QInputMethodEvent>
#include <QLineEdit>
#include <QMessageBox>
#include <QPainterPathStroker>
#include <QPointer>
#include <QSettings>
#include <QSignalBlocker>
#include <QStyleOptionComboBox>
#include <QToolButton>
#include <QTimer>
#include <QVBoxLayout>
#include <QWheelEvent>
#include <QtMath>
#include <algorithm>

// The styled native drop-down must keep an explicit disclosure indicator in
// both themes. Draw the small vector chevron without an asset dependency.
template <typename Base> class ParameterComboBox final : public Base {
public:
  explicit ParameterComboBox(QWidget *parent) : Base(parent) {}

protected:
  void paintEvent(QPaintEvent *event) override {
    Base::paintEvent(event);
    QStyleOptionComboBox option;
    this->initStyleOption(&option);
    const auto arrow = this->style()->subControlRect(
        QStyle::CC_ComboBox, &option, QStyle::SC_ComboBoxArrow, this);
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    auto ink = this->palette().windowText().color();
    ink.setAlphaF(this->isEnabled() ? .6 : .28);
    p.setPen(QPen(ink, 1.2, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    const QPointF center = arrow.center();
    p.drawLine(center + QPointF(-3, -1.5), center + QPointF(0, 1.5));
    p.drawLine(center + QPointF(0, 1.5), center + QPointF(3, -1.5));
  }
};

class ColorSwatch final : public QToolButton {
  QColor color;

public:
  ColorSwatch(QColor value, QWidget *parent)
      : QToolButton(parent), color(value) {}
  void paintEvent(QPaintEvent *) override {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    const QPointF center(width() / 2., height() / 2.);
    auto edge = qApp->palette().windowText().color();
    edge.setAlphaF(.2);
    p.setPen(QPen(edge, 1));
    p.setBrush(color);
    p.drawEllipse(center, isDown() ? 7.8 : 8, isDown() ? 7.8 : 8);
    if (isChecked() || hasFocus()) {
      p.setBrush(Qt::NoBrush);
      auto focus = qApp->palette().windowText().color();
      focus.setAlphaF(.4);
      p.setPen(QPen(isChecked() ? QColor("#0071e3") : focus, 1));
      p.drawEllipse(center, 11, 11);
    }
  }
};

AnnotationEditor::AnnotationEditor(QWidget *parent,
                                   Capture::ImageDocument &document,
                                   QString prefs)
    : QObject(parent), canvas(parent), doc(document), settingsPath(prefs) {
  loadPreferences();
  editBounds = doc.base.rect();
  panel = Capture::createChromePanel(canvas);
  panel->setCursor(Qt::ArrowCursor);
  panel->setObjectName("annotationPanel");
  panel->setStyleSheet(Capture::chromeStyle());
  auto layout = new QVBoxLayout(panel);
  layout->setContentsMargins(6, 5, 6, 5);
  layout->setSpacing(4);
  auto row = new QHBoxLayout;
  row->setSpacing(6);
  toolbar = new QToolBar(panel);
  toolbar->setObjectName("annotationTools");
  toolbar->setIconSize({18, 18});
  toolbar->setMinimumWidth(160);
  outputs = new QToolBar(panel);
  outputs->setObjectName("annotationOutputs");
  outputs->setIconSize({18, 18});
  outputs->setSizePolicy(QSizePolicy::Fixed, QSizePolicy::Fixed);
  row->addWidget(toolbar, 1);
  row->addWidget(outputs);
  layout->addLayout(row);
  parameterPanel = new QScrollArea(panel);
  parameterPanel->setObjectName("annotationOptions");
  parameterPanel->setFrameShape(QFrame::NoFrame);
  parameterPanel->setWidgetResizable(false);
  parameterPanel->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  parameterPanel->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Fixed);
  parameterPanel->setStyleSheet(
      "QScrollArea{background:transparent;border:0;} "
      "QScrollArea>QWidget>QWidget{background:transparent;}");
  parameterContent = new QWidget(parameterPanel);
  auto parameterLayout = new QHBoxLayout(parameterContent);
  parameterLayout->setContentsMargins(0, 0, 0, 0);
  parameterLayout->setSpacing(8);
  colorBar = new QToolBar(parameterContent);
  colorBar->setIconSize({18, 18});
  parameterLayout->addWidget(colorBar);
  parameters = new QToolBar(parameterContent);
  parameters->setObjectName("annotationParameters");
  parameters->setIconSize({18, 18});
  parameterLayout->addWidget(parameters);
  textParameters = new QToolBar(parameterContent);
  parameterLayout->addWidget(textParameters);
  parameterPanel->setWidget(parameterContent);
  layout->addWidget(parameterPanel);
  more = Capture::createChromeMenu(panel);
  tools = new QActionGroup(this);
  tools->setExclusive(true);
  const QList<QPair<QString, QString>> names = {
      {"select", QStringLiteral("选择")},
      {"rectangle", QStringLiteral("矩形")},
      {"ellipse", QStringLiteral("椭圆")},
      {"arrow", QStringLiteral("箭头")},
      {"line", QStringLiteral("直线")},
      {"pen", QStringLiteral("画笔")},
      {"marker", QStringLiteral("荧光笔")},
      {"text", QStringLiteral("文字")},
      {"mosaic", QStringLiteral("马赛克")},
      {"blur", QStringLiteral("高斯模糊")},
      {"eraser", QStringLiteral("橡皮擦")}};
  for (auto [id, label] : names) {
    auto a = new QAction(Capture::actionIcon(id), label, panel);
    toolbar->addAction(a);
    a->setData(id);
    a->setObjectName("captureAction_" + id);
    a->setCheckable(true);
    QString tip = label;
    if (id == "rectangle" || id == "ellipse")
      tip += QStringLiteral(" · Shift 等宽高");
    if (id == "line" || id == "arrow")
      tip += QStringLiteral(" · Shift 约束角度 · Tab 切换直线/箭头");
    if (id == "text")
      tip += QStringLiteral(" · 拖角缩放，圆柄旋转");
    if (id == "pen" || id == "marker" || id == "eraser" || id == "mosaic")
      tip += QStringLiteral(" · 连续拖动绘制，Alt 拖动当前笔画");
    if (id == "blur")
      tip += QStringLiteral(" · 框选区域，松开应用 · 滚轮调整强度");
    a->setToolTip(tip);
    tools->addAction(a);
    auto button = qobject_cast<QToolButton *>(toolbar->widgetForAction(a));
    button->setObjectName("captureTool_" + id);
    button->setMinimumSize(32, 30);
    button->setAccessibleName(label);
    connect(a, &QAction::triggered, this, [this, id] {
      choose(id);
      canvas->activateWindow();
      canvas->setFocus();
    });
  }
  toolbar->addSeparator();
  addAction("undo", QStringLiteral("撤销"), "Ctrl+Z");
  addAction("redo", QStringLiteral("重做"), "Ctrl+Y");
  addAction("clear", QStringLiteral("清除全部标注"), "Ctrl+Shift+Z");
  addAction("cancel", QStringLiteral("取消"), QStringLiteral("取消截图"));
  addAction("pin", QStringLiteral("贴图"),
            QStringLiteral("原位贴图 · 中键 / Ctrl+T"));
  addAction("save", QStringLiteral("保存"), QStringLiteral("另存为 · Ctrl+S"));
  auto moreButton = new QToolButton(outputs);
  moreButton->setObjectName("captureMore");
  moreButton->setIcon(Capture::actionIcon("more"));
  moreButton->setToolTip(QStringLiteral("更多操作"));
  moreButton->setAccessibleName(QStringLiteral("更多操作"));
  moreButton->setMenu(more);
  moreButton->setPopupMode(QToolButton::InstantPopup);
  moreButton->setProperty("popupTrigger", true);
  outputs->addWidget(moreButton);
  addAction("copy", QStringLiteral("复制"),
            QStringLiteral("复制截图并退出 · Enter / Ctrl+C"));
  auto primary =
      qobject_cast<QToolButton *>(outputs->widgetForAction(action("copy")));
  primary->setObjectName("capturePrimary");
  primary->setToolButtonStyle(Qt::ToolButtonIconOnly);

  // The hidden model retains named color values for selection and
  // accessibility; the visible controls are color swatches rather than a HEX
  // dropdown.
  colors = new QComboBox(panel);
  colors->setObjectName("annotationColor");
  colors->hide();
  auto colorGroup = new QActionGroup(this);
  colorGroup->setExclusive(true);
  for (auto value : {"#0071e3", "#e13c39", "#ffb800", "#32a852", "#943bca",
                     "#ffffff", "#171717"}) {
    colors->addItem(value, QColor(value));
    auto button = new ColorSwatch(QColor(value), colorBar);
    button->setFixedSize(24, 26);
    button->setCheckable(true);
    button->setAccessibleName(QStringLiteral("颜色 ") + value);
    button->setToolTip(value);
    auto a = new QAction(button);
    a->setCheckable(true);
    a->setData(QColor(value));
    colorGroup->addAction(a);
    button->setDefaultAction(a);
    colorActions << colorBar->addWidget(button);
    connect(a, &QAction::triggered, this, [this, value] {
      colors->setCurrentIndex(colors->findData(QColor(value)));
    });
  }
  auto custom = colorBar->addAction(Capture::actionIcon("color"),
                                    QStringLiteral("自定义颜色"));
  colorActions << custom;
  connect(custom, &QAction::triggered, this, [this] {
    auto picker = new QColorDialog(color, panel);
    picker->setAttribute(Qt::WA_DeleteOnClose);
    picker->setOption(QColorDialog::DontUseNativeDialog);
    picker->setWindowTitle(QStringLiteral("标注颜色"));
    connect(picker, &QColorDialog::colorSelected, this, [this](QColor chosen) {
      if (!chosen.isValid())
        return;
      if (colors->findData(chosen) < 0)
        colors->addItem(chosen.name(), chosen);
      colors->setCurrentIndex(colors->findData(chosen));
    });
    picker->show();
  });
  size = new QSpinBox(parameters);
  size->setObjectName("annotationSize");
  size->setRange(1, 200);
  size->setSuffix(" px");
  size->setButtonSymbols(QAbstractSpinBox::NoButtons);
  size->setAlignment(Qt::AlignCenter);
  size->setFixedWidth(64);
  size->setToolTip(QStringLiteral("线宽 / 字号 / 效果强度 · 滚轮 / [、]"));
  sizeAction = parameters->addWidget(size);
  mosaicMode = new ParameterComboBox<QComboBox>(parameters);
  mosaicMode->setObjectName("annotationMosaicMode");
  mosaicMode->addItem(QStringLiteral("涂抹"), "brush");
  mosaicMode->addItem(QStringLiteral("区域"), "region");
  mosaicMode->setAccessibleName(QStringLiteral("马赛克绘制方式"));
  mosaicMode->setToolTip(QStringLiteral("涂抹：连续画笔；区域：矩形覆盖"));
  mosaicModeAction = parameters->addWidget(mosaicMode);
  mosaicBlock = new QSpinBox(parameters);
  mosaicBlock->setObjectName("annotationMosaicBlock");
  mosaicBlock->setRange(2, 200);
  mosaicBlock->setPrefix(QStringLiteral("颗粒 "));
  mosaicBlock->setSuffix(" px");
  mosaicBlock->setButtonSymbols(QAbstractSpinBox::NoButtons);
  mosaicBlock->setFixedWidth(102);
  mosaicBlock->setAccessibleName(QStringLiteral("马赛克颗粒大小"));
  mosaicBlock->setToolTip(QStringLiteral("马赛克颗粒大小，与笔刷范围独立"));
  mosaicBlockAction = parameters->addWidget(mosaicBlock);
  font = new ParameterComboBox<QFontComboBox>(textParameters);
  font->setObjectName("annotationFont");
  font->setMaximumWidth(155);
  font->setCurrentFont(QFont(family));
  font->setAccessibleName(QStringLiteral("文字字体"));
  font->setToolTip(QStringLiteral("文字字体"));
  fontAction = textParameters->addWidget(font);
  angle = new QSpinBox(textParameters);
  angle->setObjectName("annotationRotation");
  angle->setRange(-180, 180);
  angle->setSuffix(QStringLiteral("°"));
  angle->setButtonSymbols(QAbstractSpinBox::NoButtons);
  angle->setAlignment(Qt::AlignCenter);
  angle->setFixedWidth(72);
  angle->setToolTip(QStringLiteral("文字旋转 · Shift 拖动圆柄吸附角度"));
  angle->setAccessibleName(QStringLiteral("文字旋转角度"));
  angleAction = textParameters->addWidget(angle);
  connect(colors, &QComboBox::currentIndexChanged, this,
          [this] { applyParameters("color"); });
  connect(size, &QSpinBox::valueChanged, this,
          [this] { applyParameters("size"); });
  connect(mosaicBlock, &QSpinBox::valueChanged, this,
          [this] { applyParameters("blockSize"); });
  connect(mosaicMode, &QComboBox::currentIndexChanged, this, [this] {
    if (syncing)
      return;
    complete();
    sync();
    emit toolChanged();
    canvas->update();
  });
  connect(font, &QFontComboBox::currentFontChanged, this,
          [this] { applyParameters("fontFamily"); });
  connect(angle, &QSpinBox::valueChanged, this,
          [this] { applyParameters("rotation"); });
  connect(this, &AnnotationEditor::actionRequested, this, [this](QString id) {
    if (id == "undo") {
      finishText();
      if (auto stroke = current(); stroke && stroke->tool == "blur")
        stroke->effectDraft = false;
      before = {};
      gesture.clear();
      doc.undo();
      sync();
      emit changed();
    }
    if (id == "redo") {
      if (!complete())
        return;
      doc.redo();
      if (auto stroke = current(); stroke && stroke->tool == "blur") {
        stroke->effectDraft = stroke->effectPixels.isNull();
        finishBlur();
      }
      sync();
      emit changed();
    }
    if (id == "clear") {
      discard();
      doc.clear();
      sync();
      emit changed();
    }
  });
  for (auto bar : {toolbar, outputs, colorBar, parameters, textParameters}) {
    bar->setMovable(false);
    bar->setFloatable(false);
    for (auto button : bar->findChildren<QToolButton *>())
      button->setFocusPolicy(Qt::TabFocus);
  }
  for (auto bar : {toolbar, outputs})
    for (auto button : bar->findChildren<QToolButton *>())
      button->setMinimumSize(32, 30);
  connect(qApp, &QApplication::paletteChanged, this, [this] {
    panel->setStyleSheet(Capture::chromeStyle());
    panel->update();
    layoutText();
  });
  qApp->installEventFilter(this);
  choose("select");
  panel->hide();
}
QAction *AnnotationEditor::action(const QString &id) const {
  return panel->findChild<QAction *>("captureAction_" + id);
}
QAction *AnnotationEditor::addAction(QString id, QString label,
                                     QString tooltip) {
  QAction *a;
  if (id == "undo" || id == "redo")
    a = toolbar->addAction(Capture::actionIcon(id), label);
  else if (id == "copy" || id == "pin" || id == "save" || id == "cancel")
    a = outputs->addAction(Capture::actionIcon(id, id == "copy"), label);
  else
    a = more->addAction(Capture::actionIcon(id), label);
  a->setObjectName("captureAction_" + id);
  a->setData(id);
  a->setToolTip(tooltip);
  connect(a, &QAction::triggered, this,
          [this, id] { emit actionRequested(id); });
  return a;
}
void AnnotationEditor::setPrimaryAction(const QString &id) {
  auto target = action(id);
  if (!target || id == "copy") return;
  // Form captures return to their owner by default; copy remains an explicit alternative.
  auto copy = action("copy");
  if (copy) {
    if (auto button = outputs->widgetForAction(copy))
      button->setObjectName("captureCopyAlternate");
    outputs->removeAction(copy);
    copy->setIcon(Capture::actionIcon("copy"));
    copy->setToolTip(QStringLiteral("复制截图并退出 · Ctrl+C"));
    more->addAction(copy);
  }
  more->removeAction(target);
  target->setIcon(Capture::actionIcon(id, true));
  outputs->addAction(target);
  auto button = qobject_cast<QToolButton *>(outputs->widgetForAction(target));
  button->setObjectName("capturePrimary");
  button->setMinimumSize(32, 30);
  button->setToolButtonStyle(Qt::ToolButtonIconOnly);
}
Capture::Stroke *AnnotationEditor::current() {
  return hasCurrent() ? &doc.strokes[doc.editable] : nullptr;
}
bool AnnotationEditor::hasCurrent() const {
  return doc.editable >= 0 && doc.editable < doc.strokes.size();
}

void AnnotationEditor::choose(QString name) {
  if (name == "polyline")
    name = "pen";
  closePopovers();
  if (tool != "select" && tool != "text")
    widths[tool] = lineWidth;
  if (!complete())
    return;
  tool = name;
  const int initial = name == "mosaic" || name == "eraser" ? 32
                      : name == "marker" || name == "blur" ? 12
                                                           : 3;
  if (name != "text")
    lineWidth = widths.value(name, initial);
  sync();
  pointerVisible = false;
  canvas->setCursor(tool == "select" ? Qt::ArrowCursor : Qt::CrossCursor);
  emit toolChanged();
}

void AnnotationEditor::sync() {
  syncing = true;
  if (auto stroke = current()) {
    tool = stroke->tool;
    color = stroke->color;
    lineWidth = stroke->tool == "mosaic" ? stroke->brushSize : stroke->width;
    if (stroke->tool == "mosaic") {
      blockSize = stroke->width;
      mosaicMode->setCurrentIndex(stroke->mosaicBrush ? 0 : 1);
    }
    fontSize = stroke->fontSize;
    family = stroke->fontFamily;
    angle->setValue(qRound(stroke->rotation));
  }
  for (auto a : tools->actions())
    a->setChecked(a->data() == tool);
  syncToolButtons();
  size->setRange(1, tool == "blur" ? 32 : 200);
  size->setValue(tool == "text" ? fontSize : lineWidth);
  size->setPrefix(tool == "mosaic" || tool == "eraser" ? QStringLiteral("笔刷 ")
                  : tool == "text" ? QStringLiteral("字号 ")
                  : tool == "blur" ? QStringLiteral("强度 ")
                                   : QStringLiteral("线宽 "));
  size->setFixedWidth(102);
  size->setAccessibleName(tool == "text" ? QStringLiteral("字号")
                          : tool == "blur" ? QStringLiteral("高斯模糊强度")
                          : tool == "mosaic" || tool == "eraser"
                              ? QStringLiteral("笔刷大小")
                              : QStringLiteral("线宽"));
  size->setToolTip(tool == "mosaic" || tool == "eraser"
                       ? QStringLiteral("圆形笔刷直径 · 滚轮 / [、]")
                   : tool == "blur"
                       ? QStringLiteral("高斯模糊范围 · 滚轮 / [、]")
                       : QStringLiteral("线宽 / 字号 · 滚轮 / [、]"));
  sizeAction->setVisible(tool != "mosaic" || mosaicMode->currentIndex() == 0);
  mosaicBlock->setValue(blockSize);
  mosaicModeAction->setVisible(tool == "mosaic");
  mosaicBlockAction->setVisible(tool == "mosaic");
  font->setCurrentFont(QFont(family));
  if (colors->findData(color) < 0)
    colors->addItem(color.name(), color);
  colors->setCurrentIndex(colors->findData(color));
  const bool colored = tool != "mosaic" && tool != "blur" && tool != "eraser" &&
                       tool != "select";
  colors->setEnabled(colored);
  for (auto a : colorActions)
    a->setVisible(colored);
  for (auto button : colorBar->findChildren<QToolButton *>())
    if (button->defaultAction() &&
        button->defaultAction()->data().canConvert<QColor>())
      button->defaultAction()->setChecked(
          button->defaultAction()->data().value<QColor>() == color);
  size->setEnabled(tool != "select");
  fontAction->setVisible(tool == "text");
  angleAction->setVisible(tool == "text");
  parameterPanel->setVisible(tool != "select");
  colorBar->setVisible(colored);
  textParameters->setVisible(tool == "text");
  parameters->setVisible(tool != "select");
  action("undo")->setEnabled(!doc.strokes.isEmpty());
  action("redo")->setEnabled(!doc.redoStack.isEmpty());
  action("clear")->setEnabled(!doc.strokes.isEmpty() ||
                              !doc.archivedLayer.isNull());
  syncing = false;
  emit layoutChanged();
}
void AnnotationEditor::loadPreferences() {
  if (settingsPath.isEmpty())
    return;
  QSettings settings(settingsPath, QSettings::IniFormat);
  settings.beginGroup("annotation");
  const QColor savedColor(settings.value("color").toString());
  if (savedColor.isValid())
    color = savedColor;
  const auto savedFamily = settings.value("fontFamily").toString().trimmed();
  if (!savedFamily.isEmpty() && savedFamily.size() <= 128 &&
      !savedFamily.contains('\n') && !savedFamily.contains('\r'))
    family = savedFamily;
  auto validSize = [&](const QString &key, int fallback) {
    bool ok = false;
    const int value = settings.value(key).toInt(&ok);
    return ok && value >= 1 && value <= 200 ? value : fallback;
  };
  fontSize = validSize("fontSize", fontSize);
  blockSize = std::max(2, validSize("width/mosaic", 12));
  for (QString name : {"rectangle", "ellipse", "line", "polyline", "arrow",
                       "pen", "marker", "mosaic", "blur", "eraser"}) {
    const int initial = name == "mosaic" || name == "eraser" ? 32
                        : name == "marker" || name == "blur" ? 12
                                                             : 3;
    widths[name] = validSize(
        name == "mosaic" ? "brushSize/mosaic" : "width/" + name, initial);
    if (name == "blur")
      widths[name] = std::clamp(widths[name], 1, 32);
  }
}
void AnnotationEditor::savePreference(const QString &key,
                                      const QVariant &value) {
  if (settingsPath.isEmpty())
    return;
  // Only explicit user changes are persisted, one key at a time. Inspecting
  // old strokes/undo and other open pins must not overwrite newer preferences.
  QSettings settings(settingsPath, QSettings::IniFormat);
  settings.setValue("annotation/" + key, value);
}
void AnnotationEditor::applyParameters(const QString &parameter) {
  if (syncing)
    return;
  color = colors->currentData().value<QColor>();
  family = font->currentFont().family();
  if (tool == "text")
    fontSize = size->value();
  else
    lineWidth = size->value();
  blockSize = mosaicBlock->value();
  if (auto stroke = current()) {
    if (stroke->tool == "blur" && gesture.isEmpty())
      before = *stroke;
    stroke->color = color;
    stroke->width = tool == "mosaic" ? blockSize : lineWidth;
    stroke->brushSize = lineWidth;
    stroke->fontSize = fontSize;
    stroke->fontFamily = family;
    stroke->rotation = angle->value();
    stroke->effectPixels = {};
    doc.redoStack.clear();
  }
  if (gesture.isEmpty() && !finishBlur()) {
    sync();
    emit changed();
    return;
  }
  if (tool != "text" && tool != "select")
    widths[tool] = lineWidth;
  if (parameter == "color")
    savePreference("color", color.name(QColor::HexArgb));
  else if (parameter == "fontFamily")
    savePreference("fontFamily", family);
  else if (parameter == "size" && tool != "select")
    savePreference(tool == "text"     ? "fontSize"
                   : tool == "mosaic" ? "brushSize/mosaic"
                                      : "width/" + tool,
                   size->value());
  else if (parameter == "blockSize")
    savePreference("width/mosaic", blockSize);
  for (auto button : colorBar->findChildren<QToolButton *>())
    if (button->defaultAction() &&
        button->defaultAction()->data().canConvert<QColor>())
      button->defaultAction()->setChecked(
          button->defaultAction()->data().value<QColor>() == color);
  layoutText();
  emit changed();
  // Keep numeric/font controls focused throughout multi-character input.
}

QString AnnotationEditor::contextHint() const {
  if (typing())
    return QStringLiteral("Ctrl+Enter 结束文字输入 · Esc 取消当前文字");
  if (tool == "select")
    return QStringLiteral("拖动调整选区 · 方向键微调 · Ctrl 暂停吸附");
  QString text;
  if (tool == "line" || tool == "arrow")
    text = QStringLiteral("Shift 约束角度 · Tab 切换直线/箭头");
  else if (tool == "rectangle" || tool == "ellipse")
    text = QStringLiteral("Shift 等宽高 · 滚轮调整线宽");
  else if (tool == "polyline")
    text = QStringLiteral("连续单击 · 右键完成折线");
  else if (tool == "text")
    text = QStringLiteral("单击输入文字 · 拖角缩放 · 圆柄旋转");
  else if (tool == "mosaic")
    text = mosaicMode->currentIndex() == 0
               ? QStringLiteral("连续涂抹 · 滚轮调整笔刷 · 颗粒大小独立调整")
               : QStringLiteral("拖动覆盖矩形区域 · 滚轮调整颗粒大小");
  else if (tool == "blur")
    text = QStringLiteral("框选区域，松开应用模糊 · 滚轮调整强度 · Alt 拖动区域");
  else if (tool == "eraser")
    text = QStringLiteral("连续擦除标注 · 滚轮调整笔刷范围");
  else if (tool == "pen" || tool == "marker")
    text = QStringLiteral("拖动绘制 · 滚轮调整粗细 · Alt 拖动当前笔画");
  else
    text = QStringLiteral("拖动框选效果区域 · 滚轮调整强度");
  if (hasCurrent())
    text += QStringLiteral(" · Esc 撤销当前标注");
  return text;
}
void AnnotationEditor::addHelp(const QString &context) {
  more->addSeparator();
  auto help = addAction("help", QStringLiteral("快捷键与操作说明"),
                        QStringLiteral("查看当前截图与贴图的操作方法"));
  connect(help, &QAction::triggered, this, [this, context] {
    if (auto existing = canvas->findChild<QMessageBox *>("captureHelp")) {
      existing->show();
      existing->raise();
      existing->activateWindow();
      return;
    }
    // Non-modal and owned by the canvas, so closing a capture/pin also closes
    // its help and no nested event loop can keep a finished session alive.
    auto box = new QMessageBox(
        QMessageBox::Information, QStringLiteral("快捷键与操作说明"),
        context +
            QStringLiteral("\n\n标注\n点击工具直接选择；箭头与直线独立\n"
                           "下方参数栏：颜色、粗细、字体或马赛克方式\n"
                           "Shift：等宽高 / 约束角度\n"
                           "直线、箭头工具下 Tab：互相切换\n"
                           "滚轮 / [、]：调整线宽、字号或效果强度\n"
                           "右键：完成当前标注；Esc：撤销当前标注\n"
                           "文字输入中 Ctrl+Enter：结束输入；Ctrl+C：复制文字\n"
                           "Ctrl+Z / Ctrl+Y：撤销 / 重做\n"
                           "Ctrl+Shift+Z：清除全部标注"),
        QMessageBox::Ok, canvas);
    box->setObjectName("captureHelp");
    box->setAttribute(Qt::WA_DeleteOnClose);
    box->setTextFormat(Qt::PlainText);
    box->setStyleSheet(Capture::chromeStyle());
    box->show();
  });
}

bool AnnotationEditor::reserveEdit() {
  // Reserve transparent layer and composite before allocating a new edit.
  if (allowAllocation && !allowAllocation(doc.base.sizeInBytes() * 2)) {
    emit notice(QStringLiteral("标注工作区超出图像内存预算，请先销毁其他贴图"));
    return false;
  }
  return true;
}
bool AnnotationEditor::finishBlur() {
  auto stroke = current();
  if (!stroke || stroke->tool != "blur" ||
      (!stroke->effectDraft && !stroke->effectPixels.isNull()))
    return true;
  // The previous patch can still be shared by the rollback snapshot while the
  // new region is calculated. Include it in the engine's shared pin budget.
  const auto extra = doc.gaussianWorkingCost(*stroke) +
                     before.effectPixels.sizeInBytes();
  const bool hasBudget = (!allowAllocation || allowAllocation(extra)) &&
                         doc.memoryCost() + extra <= Capture::MaxTotalBytes;
  if (hasBudget && doc.cacheEffect(doc.editable)) {
    before = {};
    return true;
  }
  if (before.tool == "blur" && !before.effectPixels.isNull() && gesture != "draw")
    *stroke = before;
  else
    stroke->effectDraft = true;
  before = {};
  emit notice(hasBudget
                  ? QStringLiteral("未能应用此区域的模糊，请调整区域或按 Esc 取消")
                  : QStringLiteral("此区域的模糊处理超出图像内存预算，请先关闭其他贴图或按 Esc 取消"));
  return false;
}
void AnnotationEditor::adjustSize(int d) {
  if (tool == "mosaic" && mosaicMode->currentIndex() == 1)
    mosaicBlock->setValue(mosaicBlock->value() + d);
  else
    size->setValue(size->value() + d);
}
void AnnotationEditor::syncToolButtons() {
  for (auto action : tools->actions()) {
    auto button = qobject_cast<QToolButton *>(toolbar->widgetForAction(action));
    button->setAccessibleName(action->text());
  }
}
void AnnotationEditor::closePopovers() {
  if (more)
    more->hide();
  if (auto popup = qApp->activePopupWidget();
      popup && panel->isAncestorOf(popup))
    popup->hide();
}
bool AnnotationEditor::closePopoverForKey(QKeyEvent *event) {
  if (event->key() != Qt::Key_Escape)
    return false;
  for (auto widget = qApp->focusWidget(); widget && widget != panel;
       widget = widget->parentWidget())
    if (widget->property("captureParameterComposing").toBool())
      return false;
  if (auto popup = qApp->activePopupWidget(); popup && popup != more)
    return false; // Let a nested font/mode menu close itself first.
  if (more->isVisible()) {
    more->hide();
    outputs->findChild<QToolButton *>("captureMore")
        ->setFocus(Qt::PopupFocusReason);
    return true;
  }
  return false;
}
QTransform AnnotationEditor::displayTransform() const {
  if (viewportTransform)
    return viewportTransform();
  QTransform scale;
  auto out = doc.outputSize();
  scale.scale(double(canvas->width()) / out.width(),
              double(canvas->height()) / out.height());
  return doc.contentTransform() * scale;
}
QPointF AnnotationEditor::imagePoint(QPointF p) const {
  return displayTransform().inverted().map(p);
}

QVector<QPointF> AnnotationEditor::handles() const {
  if (!hasCurrent())
    return {};
  const auto &stroke = doc.strokes[doc.editable];
  if (stroke.freehand() || stroke.tool == "mosaic" || stroke.tool == "blur")
    return {};
  if (stroke.tool == "line" || stroke.tool == "arrow")
    return {stroke.points.first(), stroke.points.last()};
  if (stroke.tool == "polyline")
    return stroke.points;
  const auto r = stroke.bounds();
  QVector<QPointF> points{r.topLeft(), r.topRight(), r.bottomRight(),
                          r.bottomLeft()};
  for (auto &pt : points)
    pt = stroke.localTransform().map(pt);
  return points;
}
QPointF AnnotationEditor::rotationHandle() const {
  const auto &stroke = doc.strokes[doc.editable];
  auto r = stroke.bounds();
  const double zoom = double(canvas->width()) / doc.outputSize().width();
  return stroke.localTransform().map(
      QPointF(r.center().x(), r.top() - 24 / zoom));
}
bool AnnotationEditor::hitCurrent(QPointF point) const {
  if (!hasCurrent())
    return false;
  const auto &stroke = doc.strokes[doc.editable];
  point = stroke.localTransform().inverted().map(point);
  if (stroke.tool == "text" ||
      (stroke.tool == "mosaic" && !stroke.mosaicBrush) || stroke.tool == "blur")
    return stroke.bounds().adjusted(-3, -3, 3, 3).contains(point);
  QPainterPath path;
  if (stroke.tool == "rectangle")
    path.addRect(
        QRectF(stroke.points.first(), stroke.points.last()).normalized());
  else if (stroke.tool == "ellipse")
    path.addEllipse(
        QRectF(stroke.points.first(), stroke.points.last()).normalized());
  else {
    path.moveTo(stroke.points.first());
    for (int i = 1; i < stroke.points.size(); ++i)
      path.lineTo(stroke.points[i]);
    if (stroke.tool == "arrow") {
      const auto a = stroke.points.first(), b = stroke.points.last();
      const auto angle = std::atan2(b.y() - a.y(), b.x() - a.x());
      const auto length = std::max(12, stroke.width * 4);
      for (auto offset : {-0.5, 0.5}) {
        path.moveTo(b);
        path.lineTo(b - QPointF(std::cos(angle + offset) * length,
                                std::sin(angle + offset) * length));
      }
    }
  }
  QPainterPathStroker hit;
  const int width = stroke.mosaicBrush ? stroke.brushSize : stroke.width;
  hit.setWidth(width + 6);
  hit.setCapStyle(Qt::RoundCap);
  hit.setJoinStyle(Qt::RoundJoin);
  if (std::all_of(stroke.points.begin(), stroke.points.end(),
                  [&](QPointF p) { return p == stroke.points.first(); }))
    return QLineF(point, stroke.points.first()).length() <= (width + 6) / 2.;
  return hit.createStroke(path).contains(point);
}
bool AnnotationEditor::brushTool() const {
  return tool == "eraser" ||
         (tool == "mosaic" && mosaicMode->currentIndex() == 0);
}
int AnnotationEditor::handleAt(QPointF local) const {
  const auto hs = handles();
  for (int i = 0; i < hs.size(); ++i)
    if (QLineF(displayTransform().map(hs[i]), local).length() < 9)
      return i;
  return -1;
}
void AnnotationEditor::trackPointer(QPointF local) {
  pointer = local;
  pointerVisible =
      canvas->rect().contains(local.toPoint()) &&
      editBounds.contains(imagePoint(local).toPoint()) &&
      !(panel->isVisible() && panel->geometry().contains(local.toPoint()));
  canvas->update();
}
void AnnotationEditor::paintHandles(QPainter &p) {
  if (auto stroke = current(); stroke && stroke->tool == "blur" && stroke->effectDraft) {
    p.save();
    const auto bounds = displayTransform().mapRect(stroke->bounds().intersected(editBounds));
    p.setBrush(Qt::NoBrush);
    // A black/white drawing guide remains legible over any screenshot; it is
    // display-only and never included in copied/saved/pinned image pixels.
    p.setPen(QPen(Qt::black, 3, Qt::DashLine));
    p.drawRect(bounds);
    p.setPen(QPen(Qt::white, 1, Qt::DashLine));
    p.drawRect(bounds);
    p.restore();
  }
  // Black/white paired outlines are drawing guides, readable over arbitrary
  // screenshot pixels; they are not themed component borders or export pixels.
  if (brushTool() && pointerVisible && gesture != "move") {
    const auto t = displayTransform();
    const auto center = imagePoint(pointer);
    QPainterPath circle;
    circle.addEllipse(center, lineWidth / 2., lineWidth / 2.);
    p.save();
    p.setRenderHint(QPainter::Antialiasing);
    p.setBrush(Qt::NoBrush);
    p.setPen(QPen(Qt::black, 3));
    p.drawPath(t.map(circle));
    p.setPen(QPen(Qt::white, 1));
    p.drawPath(t.map(circle));
    p.restore();
  }
  if (!hasCurrent() || textEdit ||
      (!controlsVisible && current()->tool != "text") || gesture == "draw" ||
      gesture == "polyline")
    return;
  const auto hs = handles();
  auto t = displayTransform();
  p.save();
  QPolygonF poly;
  for (auto pt : hs)
    poly << t.map(pt);
  // Controls identify the editable object without drawing an extra outline
  // around every annotation. They remain display-only, outside doc.render().
  p.setPen(QColor("#0071e3"));
  p.setBrush(Qt::white);
  for (auto pt : poly)
    p.drawRoundedRect(QRectF(pt - QPointF(3, 3), QSizeF(6, 6)), 1, 1);
  if (current()->tool == "text") {
    const auto handle = t.map(rotationHandle());
    p.drawLine((poly[0] + poly[1]) / 2, handle);
    p.drawEllipse(handle, 4, 4);
  }
  p.restore();
}

bool AnnotationEditor::press(QMouseEvent *e) {
  if (more->isVisible()) {
    closePopovers();
    return true; // Closing chrome must never start an annotation underneath it.
  }
  trackPointer(e->position());
  if (e->button() == Qt::RightButton && hasCurrent()) {
    complete();
    return true;
  }
  if (e->button() != Qt::LeftButton)
    return false;
  auto pt = imagePoint(e->position());

  if (hasCurrent() && current()->tool == "text" &&
      QLineF(displayTransform().map(rotationHandle()), e->position()).length() <
          10) {
    finishText();
    before = *current();
    start = pt;
    gesture = "rotate";
    return true;
  }
  if (!editBounds.contains(pt.toPoint()) && !hitCurrent(pt))
    return false;
  canvas->setFocus();
  if (tool == "polyline" && gesture == "polyline" && current()) {
    auto s = current();
    s->points.last() = pt;
    if (s->points.size() < 100000)
      s->points << pt;
    emit changed();
    return true;
  }
  finishText();
  grip = -1;

  if (auto s = current(); s && (!(s->freehand() || tool == "mosaic" || tool == "blur") ||
                                e->modifiers().testFlag(Qt::AltModifier))) {
    grip = handleAt(e->position());
    if (grip >= 0 || hitCurrent(pt)) {
      start = pt;
      before = *s;
      gesture = grip >= 0 ? "resize" : "move";
      controlsVisible = true;
      return true;
    }
  }
  if (tool == "select")
    return false;
  if (!reserveEdit())
    return true;
  if (!complete())
    return true;
  before = {};
  Capture::Stroke s{tool, {pt, pt}, color, lineWidth, fontSize, {}};
  s.clipBounds = editBounds;
  s.effectDraft = tool == "blur";
  if (tool == "mosaic") {
    s.mosaicBrush = mosaicMode->currentIndex() == 0;
    s.width = blockSize;
    s.brushSize = lineWidth;
  }
  s.fontFamily = family;
  if (tool == "text") {
    auto remaining = editBounds.bottomRight() - pt.toPoint();
    s.points.last() = pt + QPointF(std::max(1, std::min(320, remaining.x())),
                                   std::max(1, std::min(120, remaining.y())));
    // Empty text is a transient object; it is discarded when the editor closes.
    if (doc.append(s, true))
      emit notice(QStringLiteral("仅保留最近 100 步撤销，较早标注仍可擦除"));
    openText();
  } else {
    if (doc.append(s))
      emit notice(QStringLiteral("仅保留最近 100 步撤销，较早标注仍可擦除"));
    gesture = tool == "polyline" ? "polyline" : "draw";
  }
  start = pt;
  sync();
  emit changed();
  return true;
}
bool AnnotationEditor::move(QMouseEvent *e) {
  trackPointer(e->position());
  if (gesture.isEmpty()) {
    auto cursor = brushTool() && pointerVisible ? Qt::BlankCursor
                  : tool == "select"            ? Qt::ArrowCursor
                                                : Qt::CrossCursor;
    controlsVisible = false;
    if (auto s = current()) {
      if (hitCurrent(imagePoint(e->position())) &&
          (!(s->freehand() || tool == "mosaic" || tool == "blur") ||
           e->modifiers().testFlag(Qt::AltModifier))) {
        cursor = Qt::SizeAllCursor;
        controlsVisible = true;
      }
      if (s->tool == "text" &&
          QLineF(displayTransform().map(rotationHandle()), e->position())
                  .length() < 10)
        cursor = Qt::CrossCursor;
      const int at = handleAt(e->position());
      if (at >= 0) {
        cursor =
            s->tool == "line" || s->tool == "arrow" || s->tool == "polyline"
                ? Qt::CrossCursor
            : at % 2 ? Qt::SizeBDiagCursor
                     : Qt::SizeFDiagCursor;
        controlsVisible = true;
      }
    }
    canvas->setCursor(cursor);
  } else {
    canvas->setCursor(gesture == "move"               ? Qt::SizeAllCursor
                      : brushTool() && pointerVisible ? Qt::BlankCursor
                                                      : Qt::CrossCursor);
  }
  if (gesture.isEmpty() || !current())
    return false;
  if (gesture != "polyline" && !(e->buttons() & Qt::LeftButton))
    return false;
  auto pt = imagePoint(e->position());
  pt.setX(std::clamp(pt.x(), double(editBounds.left()),
                     double(editBounds.x() + editBounds.width())));
  pt.setY(std::clamp(pt.y(), double(editBounds.top()),
                     double(editBounds.y() + editBounds.height())));

  auto s = current();
  s->effectPixels = {};
  s->effectDraft = s->tool == "blur";
  if (gesture == "rotate") {
    const auto center = before.bounds().center();
    const auto a = start - center, b = pt - center;
    qreal degrees =
        before.rotation +
        qRadiansToDegrees(std::atan2(b.y(), b.x()) - std::atan2(a.y(), a.x()));
    if (e->modifiers().testFlag(Qt::ShiftModifier))
      degrees = qRound(degrees / 15) * 15;
    s->rotation = std::remainder(degrees, 360.);
  } else if (gesture == "move") {
    s->points = before.points;
    for (auto &p : s->points)
      p += pt - start;

  } else if (gesture == "resize" && (s->tool == "line" || s->tool == "arrow" ||
                                     s->tool == "polyline")) {
    const auto index =
        grip == 1 && s->tool != "polyline" ? s->points.size() - 1 : grip;
    if (e->modifiers().testFlag(Qt::ShiftModifier) && s->tool != "polyline") {
      const auto anchor =
          before.points[index == 0 ? before.points.size() - 1 : 0];
      const auto delta = pt - anchor;
      const auto angle =
          qRound(std::atan2(delta.y(), delta.x()) / (M_PI / 4)) * (M_PI / 4);
      const auto length = std::hypot(delta.x(), delta.y());
      pt = anchor + QPointF(std::cos(angle) * length, std::sin(angle) * length);
    }
    s->points[index] = pt;
  } else if (gesture == "resize" && s->tool == "text") {
    const auto r = before.bounds();
    const QVector<QPointF> corners{r.topLeft(), r.topRight(), r.bottomRight(),
                                   r.bottomLeft()};
    const auto opposite = corners[(grip + 2) % 4];
    const auto local = before.localTransform().inverted().map(pt);
    const auto diagonal = corners[grip] - opposite, delta = local - opposite;
    const auto factor =
        std::clamp(QPointF::dotProduct(delta, diagonal) /
                       std::max(1., QPointF::dotProduct(diagonal, diagonal)),
                   1. / before.fontSize, 200. / before.fontSize);
    s->points = before.points;
    for (auto &point : s->points)
      point = opposite + (point - opposite) * factor;
    s->fontSize = std::clamp(qRound(before.fontSize * factor), 1, 200);
    if (e->modifiers().testFlag(Qt::ShiftModifier))
      s->rotation = 0;
    const auto correction = before.localTransform().map(opposite) -
                            s->localTransform().map(opposite);
    for (auto &point : s->points)
      point += correction;
  } else if (gesture == "resize") {
    auto r = before.bounds();
    const auto opposite = QVector<QPointF>{r.bottomRight(), r.bottomLeft(),
                                           r.topLeft(), r.topRight()}[grip];
    QRectF next(opposite, pt);
    next = next.normalized();
    if (next.width() > 1 && next.height() > 1) {
      s->points = before.points;
      for (auto &p : s->points)
        p = next.topLeft() +
            QPointF((p.x() - r.x()) / r.width() * next.width(),
                    (p.y() - r.y()) / r.height() * next.height());
    }
  } else {
    auto anchor = gesture == "polyline" && s->points.size() > 1
                      ? s->points[s->points.size() - 2]
                      : start;
    if (e->modifiers().testFlag(Qt::ShiftModifier)) {
      auto d = pt - anchor;
      if (tool == "rectangle" || tool == "ellipse") {
        auto n = std::max(qAbs(d.x()), qAbs(d.y()));
        pt = anchor + QPointF(d.x() < 0 ? -n : n, d.y() < 0 ? -n : n);
      } else if (tool == "line" || tool == "arrow" || tool == "polyline") {
        auto a = qRound(std::atan2(d.y(), d.x()) / (M_PI / 4)) * (M_PI / 4);
        auto n = std::hypot(d.x(), d.y());
        pt = anchor + QPointF(std::cos(a) * n, std::sin(a) * n);
      } else if (tool == "marker") {
        pt = qAbs(d.x()) >= qAbs(d.y()) ? QPointF(pt.x(), anchor.y())
                                        : QPointF(anchor.x(), pt.y());
      }
    }
    if (s->freehand()) {
      if (s->points.size() < 100000)
        s->points << pt;
    } else
      s->points.last() = pt;
  }
  doc.redoStack.clear();
  emit changed();
  return true;
}
bool AnnotationEditor::release(QMouseEvent *e) {
  if (e->button() != Qt::LeftButton || gesture.isEmpty())
    return false;
  finishBlur();
  if (gesture != "polyline")
    gesture.clear();
  controlsVisible = false;
  sync();
  emit changed();
  return true;
}
bool AnnotationEditor::doubleClick(QMouseEvent *e) {
  if (e->button() != Qt::LeftButton || !current() ||
      current()->tool != "text" || !hitCurrent(imagePoint(e->position())))
    return false;
  gesture.clear();
  if (!textEdit)
    openText();
  return true;
}

void AnnotationEditor::openText() {
  textView = new QGraphicsView(canvas);
  textView->setObjectName("annotationTextView");
  textView->setFrameStyle(0);
  textView->setStyleSheet("background:transparent;border:0;");
  textView->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  textView->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  textView->setAlignment(Qt::AlignLeft | Qt::AlignTop);
  auto scene = new QGraphicsScene(textView);
  textView->setScene(scene);
  textEdit = new QTextEdit;
  textEdit->setObjectName("annotationText");
  textEdit->setAcceptRichText(false);
  textEdit->setFrameStyle(0);
  textEdit->viewport()->setAutoFillBackground(false);
  textEdit->setContextMenuPolicy(Qt::NoContextMenu);
  textEdit->document()->setDocumentMargin(0);
  textEdit->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  textEdit->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  textEdit->setPlainText(current()->text);
  textProxy = scene->addWidget(textEdit);
  connect(textEdit, &QTextEdit::textChanged, this, [this] {
    if (auto stroke = current()) {
      stroke->text = textEdit->toPlainText();
      emit changed();
    }
  });
  layoutText();
  textView->show();
  textView->raise();
  textView->setFocus();
  textEdit->setFocus();
}
void AnnotationEditor::layoutText() {
  if (!textEdit || !current())
    return;
  const auto stroke = current();
  const auto bounds = stroke->bounds();
  QFont font(stroke->fontFamily);
  font.setPixelSize(stroke->fontSize);
  textEdit->setFont(font);
  // The drawing preview must reveal the captured pixels behind the text.
  // Its document stroke is hidden only in canvas preview while this widget
  // edits it.
  textEdit->setStyleSheet(
      QString("QTextEdit{color:%1;background:transparent;border:0;padding:0;}")
          .arg(stroke->color.name()));
  textEdit->setFixedSize(qMax(1, qCeil(bounds.width())),
                         qMax(1, qCeil(bounds.height())));
  textProxy->setPos(bounds.topLeft());
  textProxy->setTransformOriginPoint(bounds.width() / 2, bounds.height() / 2);
  textProxy->setRotation(stroke->rotation);
  const auto sceneBounds = textProxy->sceneBoundingRect();
  textView->setSceneRect(sceneBounds);
  textView->setTransform(displayTransform());
  textView->setGeometry(
      displayTransform().mapRect(sceneBounds).toAlignedRect());
}
void AnnotationEditor::closeTextWidget() {
  if (!textEdit)
    return;
  textEdit->disconnect(this);
  textView->hide();
  textView->deleteLater();
  textEdit = nullptr;
  textView = nullptr;
  textProxy = nullptr;
  composing = false;
}
void AnnotationEditor::finishText() {
  if (!textEdit)
    return;
  QGuiApplication::inputMethod()->commit();
  if (auto stroke = current())
    stroke->text = textEdit->toPlainText();
  closeTextWidget();
  if (current() && current()->text.trimmed().isEmpty()) {
    doc.strokes.removeAt(doc.editable);
    doc.editable = -1;
  }
  canvas->setFocus();
  emit changed();
}

bool AnnotationEditor::complete() {
  finishText();
  if (!finishBlur())
    return false;
  gesture.clear();
  controlsVisible = false;
  doc.editable = -1;
  sync();
  emit changed();
  return true;
}

void AnnotationEditor::discard() {
  closeTextWidget();
  before = {};
  composing = false;
  gesture.clear();
  if (hasCurrent())
    doc.strokes.removeAt(doc.editable);
  doc.editable = -1;
  sync();
  canvas->setFocus();
  emit changed();
}

bool AnnotationEditor::key(QKeyEvent *e) {
  if (closePopoverForKey(e))
    return true;
  if (e->key() == Qt::Key_Space && !gesture.isEmpty())
    return true;
  if (e->key() == Qt::Key_Tab && (tool == "line" || tool == "arrow")) {
    tool = tool == "line" ? "arrow" : "line";
    if (auto stroke = current()) {
      stroke->tool = tool;
      doc.redoStack.clear();
    }
    sync();
    emit changed();
    return true;
  }
  if (hasCurrent() && !typing()) {
    QPointF delta;
    if (e->key() == Qt::Key_Left)
      delta = {-1, 0};
    if (e->key() == Qt::Key_Right)
      delta = {1, 0};
    if (e->key() == Qt::Key_Up)
      delta = {0, -1};
    if (e->key() == Qt::Key_Down)
      delta = {0, 1};
    if (!delta.isNull()) {
      if (current()->tool == "blur")
        before = *current();
      if (e->modifiers().testFlag(Qt::ShiftModifier))
        delta *= 10;
      for (auto &point : current()->points)
        point += delta;
      current()->effectPixels = {};
      doc.redoStack.clear();
      finishBlur();
      emit changed();
      return true;
    }
  }
  if (e->key() == Qt::Key_Escape && hasCurrent()) {
    discard();
    return true;
  }
  if (e->modifiers().testFlag(Qt::ControlModifier)) {
    if (e->key() == Qt::Key_Z) {
      emit actionRequested(e->modifiers().testFlag(Qt::ShiftModifier) ? "clear"
                                                                      : "undo");
      return true;
    }
    if (e->key() == Qt::Key_Y) {
      emit actionRequested("redo");
      return true;
    }
  } else if (tool != "select") {
    if (e->key() == Qt::Key_1 || e->key() == Qt::Key_BracketLeft) {
      adjustSize(-1);
      return true;
    }
    if (e->key() == Qt::Key_2 || e->key() == Qt::Key_BracketRight) {
      adjustSize(1);
      return true;
    }
  }
  return false;
}
bool AnnotationEditor::wheel(QWheelEvent *e) {
  if (tool == "select" || e->modifiers() != Qt::NoModifier)
    return false;
  adjustSize(e->angleDelta().y() > 0 ? 1 : -1);
  return true;
}

bool AnnotationEditor::eventFilter(QObject *o, QEvent *e) {
  auto widget = qobject_cast<QWidget *>(o);
  const bool parameterInput = widget && parameterPanel->isAncestorOf(widget);
  QWidget *parameterControl = nullptr;
  if (parameterInput)
    for (auto input = widget; input && input != parameterPanel;
         input = input->parentWidget())
      if (qobject_cast<QComboBox *>(input) ||
          qobject_cast<QAbstractSpinBox *>(input)) {
        parameterControl = input;
        break;
      }
  if (parameterInput && e->type() == QEvent::InputMethod) {
    const bool composing =
        !static_cast<QInputMethodEvent *>(e)->preeditString().isEmpty();
    widget->setProperty("captureParameterComposing", composing);
    // Editable combo boxes may own keyboard focus while their line edit
    // receives preedit events. Keep composition on the logical input control.
    if (parameterControl)
      parameterControl->setProperty("captureParameterComposing", composing);
  }
  if (parameterInput && e->type() == QEvent::KeyPress) {
    const auto key = static_cast<QKeyEvent *>(e)->key();
    if (key == Qt::Key_Escape || key == Qt::Key_Return || key == Qt::Key_Enter)
      for (auto input = widget; input && input != parameterPanel;
           input = input->parentWidget())
        if (input->property("captureParameterComposing").toBool()) {
          if (key == Qt::Key_Escape)
            QGuiApplication::inputMethod()->reset();
          else
            QGuiApplication::inputMethod()->commit();
          input->setProperty("captureParameterComposing", false);
          if (parameterControl) {
            parameterControl->setProperty("captureParameterComposing", false);
            for (auto child : parameterControl->findChildren<QWidget *>())
              child->setProperty("captureParameterComposing", false);
          }
          return true;
        }
  }
  if (e->type() == QEvent::KeyPress && o == more &&
      closePopoverForKey(static_cast<QKeyEvent *>(e)))
    return true;
  if ((o == canvas || o == panel) &&
      (e->type() == QEvent::Hide || e->type() == QEvent::Close))
    closePopovers();
  if ((o == canvas && e->type() == QEvent::Leave) ||
      (o == panel && e->type() == QEvent::Enter)) {
    pointerVisible = false;
    controlsVisible = false;
    if (brushTool())
      canvas->setCursor(Qt::CrossCursor);
    canvas->update();
  }
  // QWidget normally consumes Tab for focus traversal before keyPressEvent.
  // Reserve it only while the canvas owns the line/arrow editing gesture.
  if (o == canvas && e->type() == QEvent::KeyPress) {
    auto event = static_cast<QKeyEvent *>(e);
    if (event->key() == Qt::Key_Tab && event->modifiers() == Qt::NoModifier &&
        (tool == "line" || tool == "arrow"))
      return key(event);
  }
  for (auto ancestor = widget; ancestor; ancestor = ancestor->parentWidget())
    if (qobject_cast<QMenu *>(ancestor) ||
        qobject_cast<QColorDialog *>(ancestor))
      return QObject::eventFilter(o, e);
  if (e->type() == QEvent::KeyPress && widget &&
      (widget == panel || panel->isAncestorOf(widget))) {
    auto key = static_cast<QKeyEvent *>(e);
    if (auto button = qobject_cast<QToolButton *>(widget);
        button && key->modifiers() == Qt::NoModifier) {
      if (key->key() == Qt::Key_Space || key->key() == Qt::Key_Left ||
          key->key() == Qt::Key_Right)
        return false;
      if (key->key() == Qt::Key_Return || key->key() == Qt::Key_Enter) {
        button->click();
        return true;
      }
    }
    bool input = false;
    for (auto w = widget; w && w != panel; w = w->parentWidget())
      if (qobject_cast<QLineEdit *>(w) || qobject_cast<QAbstractSpinBox *>(w) ||
          qobject_cast<QComboBox *>(w))
        input = true;
    if (input) {
      if (key->key() == Qt::Key_Escape || key->key() == Qt::Key_Return ||
          key->key() == Qt::Key_Enter) {
        if (auto spin = qobject_cast<QAbstractSpinBox *>(widget))
          spin->interpretText();
        canvas->activateWindow();
        if (textView) {
          textView->setFocus();
          textEdit->setFocus();
        } else
          canvas->setFocus();
        QPointer<QWidget> target =
            textEdit ? static_cast<QWidget *>(textEdit) : canvas;
        QTimer::singleShot(0, target, [target] {
          if (!target || !target->isVisible())
            return;
          target->window()->activateWindow();
          target->setFocus(Qt::OtherFocusReason);
        });
        return true;
      }
    } else if (key->key() != Qt::Key_Tab && key->key() != Qt::Key_Backtab) {
      QApplication::sendEvent(canvas, key);
      return true;
    }
  }
  if (o == textEdit || (textEdit && o == textEdit->viewport())) {
    if (e->type() == QEvent::MouseButtonPress &&
        static_cast<QMouseEvent *>(e)->button() == Qt::RightButton) {
      complete();
      return true;
    }
    if (e->type() == QEvent::InputMethod)
      composing =
          !static_cast<QInputMethodEvent *>(e)->preeditString().isEmpty();
    if (e->type() == QEvent::KeyPress) {
      auto k = static_cast<QKeyEvent *>(e);
      if (k->key() == Qt::Key_Escape) {
        if (composing) {
          QGuiApplication::inputMethod()->reset();
          composing = false;
        } else
          discard();
        return true;
      }
      if (k->modifiers().testFlag(Qt::ControlModifier) && !composing) {
        if (k->key() == Qt::Key_Return) {
          finishText();
          sync();
          return true;
        }
        if (k->key() == Qt::Key_S || k->key() == Qt::Key_T) {
          finishText();
          emit actionRequested(k->key() == Qt::Key_T ? "pin"
                               : k->modifiers().testFlag(Qt::ShiftModifier)
                                   ? "quickSave"
                                   : "save");
          return true;
        }
      }
    }
  }
  return QObject::eventFilter(o, e);
}

void AnnotationEditor::fitPanel(int maxWidth) {
  auto vertical = qobject_cast<QVBoxLayout *>(panel->layout());
  auto row = qobject_cast<QHBoxLayout *>(vertical->itemAt(0)->layout());
  const int toolsWidth = toolbar->sizeHint().width();
  const int outputsWidth = outputs->sizeHint().width();
  const bool split = maxWidth < toolsWidth + outputsWidth + 25;
  if (split && row->indexOf(outputs) >= 0) {
    row->removeWidget(outputs);
    vertical->insertWidget(1, outputs, 0, Qt::AlignRight);
  } else if (!split && vertical->indexOf(outputs) >= 0) {
    vertical->removeWidget(outputs);
    row->addWidget(outputs);
  }
  // Measure visible fields explicitly: a previously hidden QToolBar can keep
  // a stale size hint, which would move controls into its overflow menu.
  for (auto bar : {colorBar, parameters, textParameters}) {
    int width = 8;
    for (auto action : bar->actions()) {
      if (!action->isVisible())
        continue;
      if (auto widget = bar->widgetForAction(action)) {
        widget->ensurePolished();
        width += widget->sizeHint()
                     .expandedTo(widget->minimumSize())
                     .boundedTo(widget->maximumSize())
                     .width() +
                 2;
      }
    }
    bar->setFixedWidth(width);
    bar->layout()->activate();
  }
  parameterContent->layout()->invalidate();
  parameterContent->layout()->activate();
  const auto optionSize = parameterContent->sizeHint();
  parameterContent->resize(optionSize);
  const int mainWidth = split ? std::max(toolsWidth, outputsWidth) + 12
                              : toolsWidth + outputsWidth + 25;
  const int natural = std::max(
      mainWidth, parameterPanel->isHidden() ? 0 : optionSize.width() + 12);
  panel->setFixedWidth(std::min(maxWidth, natural));
  parameterPanel->setFixedHeight(
      optionSize.height() +
      (optionSize.width() > panel->width() - 12
           ? panel->style()->pixelMetric(QStyle::PM_ScrollBarExtent)
           : 0));
  panel->layout()->activate();
  panel->adjustSize();
}
