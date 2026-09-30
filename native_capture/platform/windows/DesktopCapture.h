#pragma once
#include <QImage>
#include <QScreen>
namespace Capture {
bool interactiveDesktopAvailable();
QImage captureDesktop(QScreen *screen, QString *error);
QImage readClipboardImage(QString *error);
bool writeClipboardImage(const QImage &image, QString *error);
} // namespace Capture
