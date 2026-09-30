#include "SaveActions.h"
#include "ImageDocument.h"
#include <QDateTime>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QPointer>
#include <QSettings>
#include <QUuid>
namespace Capture {
void configureSaveDirectory(QWidget *owner, const QString &settingsPath) {
  QPointer<QWidget> guard(owner);
  QSettings settings(settingsPath, QSettings::IniFormat);
  auto dir = QFileDialog::getExistingDirectory(
      owner, QStringLiteral("设置快速保存目录"),
      settings.value("quickSaveDirectory").toString());
  if (guard && !dir.isEmpty())
    settings.setValue("quickSaveDirectory", dir);
}
bool saveWithDialog(QWidget *owner, const QImage &image, bool quick,
                    const QString &settingsPath, QString *error,
                    QString *savedPath) {
  if (savedPath)
    savedPath->clear();
  QPointer<QWidget> guard(owner);
  QString path;
  if (quick) {
    QSettings settings(settingsPath, QSettings::IniFormat);
    auto dir = settings.value("quickSaveDirectory").toString();
    if (dir.isEmpty()) {
      dir = QFileDialog::getExistingDirectory(
          owner, QStringLiteral("首次快速保存：请选择保存目录"));
      if (!guard || dir.isEmpty())
        return false;
      settings.setValue("quickSaveDirectory", dir);
    }
    if (!QDir(dir).exists()) {
      *error = QStringLiteral("快速保存目录已不可用，请重新设置目录");
      return false;
    }
    path = QDir(dir).filePath(
        QStringLiteral("截图-%1-%2.png")
            .arg(QDateTime::currentDateTime().toString("yyyyMMdd-HHmmss-zzz"),
                 QUuid::createUuid().toString(QUuid::WithoutBraces).left(8)));
  } else
    path = QFileDialog::getSaveFileName(owner, QStringLiteral("保存图片"),
                                        QStringLiteral("截图.png"),
                                        "PNG (*.png);;JPEG (*.jpg *.jpeg)");
  if (!guard || path.isEmpty())
    return false;
  if (!saveImage(image, path, error))
    return false;
  if (savedPath)
    *savedPath = QDir::toNativeSeparators(QFileInfo(path).absoluteFilePath());
  return true;
}
} // namespace Capture
