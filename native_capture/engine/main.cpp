#include "CaptureEngine.h"
#include "CaptureAppearance.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QFileInfo>
#include <QImageReader>
#include <windows.h>
int main(int argc, char **argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  wchar_t executable[32768]{};
  GetModuleFileNameW(nullptr, executable, 32768);
  QCoreApplication::setLibraryPaths(
      {QFileInfo(QString::fromWCharArray(executable)).absolutePath()});
  QApplication app(argc, argv);
  app.setStyle("Fusion");
  Capture::applyTheme({});
  app.setQuitOnLastWindowClosed(false);
  app.setApplicationName("AbandonCapture");
  QImageReader::setAllocationLimit(128);
  QCommandLineParser parser;
  parser.addOption(QCommandLineOption("pipe", "Owned pipe", "name"));
  parser.addOption(QCommandLineOption("token", "Launch token", "token"));
  parser.addOption(QCommandLineOption("root", "Session assets", "directory"));
  parser.process(app);
  if (parser.value("pipe").isEmpty() || parser.value("token").size() != 64 ||
      parser.value("root").isEmpty())
    return 2;
  CaptureEngine engine(parser.value("pipe"), parser.value("token"),
                       parser.value("root"));
  return app.exec();
}
