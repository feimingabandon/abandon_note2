#pragma once
#include "ImageDocument.h"
#include <QActionGroup>
#include <QComboBox>
#include <QFontComboBox>
#include <QGraphicsProxyWidget>
#include <QGraphicsView>
#include <QHash>
#include <QKeyEvent>
#include <QMenu>
#include <QMouseEvent>
#include <QPainter>
#include <QScrollArea>
#include <QSpinBox>
#include <QTextEdit>
#include <QToolBar>
#include <QToolButton>
#include <QWidget>
#include <functional>

class AnnotationEditor : public QObject {
  Q_OBJECT
public:
  AnnotationEditor(QWidget *canvas, Capture::ImageDocument &document,
                   QString settingsPath = {});
  QWidget *panel;
  QToolBar *toolbar;
  QToolBar *parameters;
  QToolBar *outputs;
  QString tool = "select";
  QAction *addAction(QString id, QString label, QString tooltip);
  QAction *action(const QString &id) const;
  void setPrimaryAction(const QString &id);
  QTextEdit *textWidget() const { return textEdit; }
  bool gesturing() const { return !gesture.isEmpty(); }
  void choose(QString name);
  bool press(QMouseEvent *event);
  bool move(QMouseEvent *event);
  bool release(QMouseEvent *event);
  bool doubleClick(QMouseEvent *event);
  bool key(QKeyEvent *event);
  bool wheel(QWheelEvent *event);
  void paintHandles(QPainter &p);
  bool complete();
  void discard();
  void finishText();
  bool hasCurrent() const;
  bool typing() const { return textEdit != nullptr; }
  QPointF imagePoint(QPointF local) const;
  QTransform displayTransform() const;
  void sync();
  void fitPanel(int maxWidth);
  void closePopovers();
  bool closePopoverForKey(QKeyEvent *event);
  QString contextHint() const;
  void addHelp(const QString &context);
  QRect
      editBounds; // Physical base-image coordinates; limits text/drawing input.
  std::function<bool(qint64)> allowAllocation;
  std::function<QTransform()> viewportTransform;
signals:
  void changed();
  void toolChanged();
  void layoutChanged();
  void actionRequested(QString action);
  void notice(QString message);

protected:
  bool eventFilter(QObject *, QEvent *) override;

private:
  QWidget *canvas;
  Capture::ImageDocument &doc;
  QActionGroup *tools;
  QSpinBox *size, *angle, *mosaicBlock;
  QComboBox *mosaicMode;
  QFontComboBox *font;
  QComboBox *colors;
  QMenu *more;
  QScrollArea *parameterPanel;
  QWidget *parameterContent;
  QToolBar *colorBar, *textParameters;
  QList<QAction *> colorActions;
  QAction *fontAction, *angleAction, *sizeAction, *mosaicModeAction,
      *mosaicBlockAction;
  QHash<QString, int> widths;
  QTextEdit *textEdit = nullptr;
  QGraphicsView *textView = nullptr;
  QGraphicsProxyWidget *textProxy = nullptr;
  bool composing = false, syncing = false;
  QString gesture;
  QPointF start;
  Capture::Stroke before;
  int grip = -1;
  QColor color = QColor("#0071e3");
  int lineWidth = 3, fontSize = 24;
  int blockSize = 12;
  bool controlsVisible = false, pointerVisible = false;
  QPointF pointer;
  QString family = "Microsoft YaHei UI";
  QString settingsPath;
  void loadPreferences();
  void savePreference(const QString &key, const QVariant &value);
  Capture::Stroke *current();
  void applyParameters(const QString &parameter);
  void adjustSize(int delta);
  void openText();
  void layoutText();
  bool reserveEdit();
  bool finishBlur();
  QVector<QPointF> handles() const;
  QPointF rotationHandle() const;
  bool hitCurrent(QPointF point) const;
  bool brushTool() const;
  int handleAt(QPointF local) const;
  void trackPointer(QPointF local);
  void syncToolButtons();
  void closeTextWidget();
};
