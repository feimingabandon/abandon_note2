#pragma once
#include <QImage>
#include <QWidget>
namespace Capture {
bool saveWithDialog(QWidget *owner, const QImage &image, bool quick,
                    const QString &settingsPath, QString *error,
                    QString *savedPath = nullptr);
void configureSaveDirectory(QWidget *owner, const QString &settingsPath);
} // namespace Capture
