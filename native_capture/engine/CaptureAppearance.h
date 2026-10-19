#pragma once
#include <QIcon>
#include <QJsonObject>
#include <QMenu>
#include <QWidget>
namespace Capture {
QIcon actionIcon(const QString &name, bool primary = false);
QString chromeStyle();
void applyTheme(const QJsonObject &theme);
QWidget *createChromePanel(QWidget *parent);
QMenu *createChromeMenu(QWidget *parent);
} // namespace Capture
