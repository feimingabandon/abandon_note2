#include "CaptureEngine.h"
#include "CaptureAppearance.h"
#include "DesktopCapture.h"
#include "SaveActions.h"
#include <QApplication>
#include <QClipboard>
#include <QDir>
#include <QFileDialog>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMessageBox>
#include <QMimeData>
#include <QRegularExpression>
#include <QTimer>
#include <QUuid>

CaptureEngine::CaptureEngine(QString pipe, QString secret, QString directory)
    : token(secret), root(directory) {
  settingsPath = QDir(root).absoluteFilePath("../capture-settings.ini");
  server.setSocketOptions(QLocalServer::UserAccessOption);
  if (!server.listen(pipe)) {
    QTimer::singleShot(0, qApp, [] { qApp->exit(2); });
    return;
  }
  connect(&server, &QLocalServer::newConnection, this, [this] {
    auto candidate = server.nextPendingConnection();
    if (socket) {
      candidate->abort();
      candidate->deleteLater();
      return;
    }
    socket = candidate;
    connect(socket, &QLocalSocket::disconnected, qApp, &QApplication::quit);
    connect(socket, &QLocalSocket::readyRead, this, [this] {
      input += socket->readAll();
      if (input.size() > 65536) {
        socket->abort();
        return;
      }
      while (input.contains('\n')) {
        int end = input.indexOf('\n');
        auto line = input.left(end);
        input.remove(0, end + 1);
        QJsonParseError error;
        auto doc = QJsonDocument::fromJson(line, &error);
        if (error.error != QJsonParseError::NoError || !doc.isObject()) {
          socket->abort();
          return;
        }
        receive(doc.object());
      }
    });
  });
  QTimer::singleShot(10000, this, [this] {
    if (!authenticated)
      qApp->quit();
  });
  auto topology = [this] {
    lastArea = {};
    lastScreen.clear();
    if (!session.isEmpty())
      finish("display-changed");
    for (auto p : pins)
      if (p)
        p->constrain();
  };
  connect(qApp, &QGuiApplication::screenRemoved, this,
          [topology](QScreen *) { topology(); });
  auto watchScreen = [this, topology](QScreen *screen) {
    connect(screen, &QScreen::geometryChanged, this,
            [topology](QRect) { topology(); });
    connect(screen, &QScreen::logicalDotsPerInchChanged, this,
            [topology](qreal) { topology(); });
  };
  connect(qApp, &QGuiApplication::screenAdded, this,
          [topology, watchScreen](QScreen *screen) {
            watchScreen(screen);
            topology();
          });
  for (auto screen : QGuiApplication::screens())
    watchScreen(screen);
}
CaptureEngine::~CaptureEngine() {
  finish("cancelled");
  const auto owned = pins;
  for (auto p : owned)
    if (p) {
      p->closing = {};
      delete p;
    }
  closedPin.reset();
}
void CaptureEngine::send(QJsonObject message) {
  if (socket)
    socket->write(QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n');
}
void CaptureEngine::report(QString error) {
  send({{"type", "error"}, {"sessionId", session}, {"message", error}});
  if (selected)
    selected->showError(error);
}
void CaptureEngine::receive(QJsonObject m) {
  auto type = m["type"].toString();
  if (!authenticated) {
    if (type != "hello" || m["token"].toString() != token ||
        m["version"].toInt() != 1) {
      socket->abort();
      return;
    }
    authenticated = true;
    send({{"type", "ready"}, {"version", 1}});
    return;
  }
  if (type == "shutdown") {
    finish("cancelled");
    qApp->quit();
    return;
  }
  if (type == "theme") {
    Capture::applyTheme(m["theme"].toObject());
    return;
  }
  if (type == "capture") {
    if (session.isEmpty())
      capture(m);
    else if (selected) {
      selected->raise();
      selected->activateWindow();
    }
    return;
  }
  if (type == "cancel" && m["sessionId"].toString() == session) {
    finish("cancelled");
    return;
  }
  if (type == "ack" && m["sessionId"].toString() == session &&
      m["deliveryId"].toString() == delivery && !delivery.isEmpty()) {
    QFile::remove(QDir(root).filePath(session + "/" + delivery + ".png"));
    delivery.clear();
    busy = false;
    if (m["accepted"].toBool())
      finish("delivered");
    else {
      for (auto o : overlays)
        if (o)
          o->showDesktop();
      if (selected) {
        selected->raise();
        selected->activateWindow();
        selected->showError(m["message"].toString(
            QStringLiteral("来源已不可用，请复制、保存或贴图")));
      }
    }
    return;
  }
  if (!session.isEmpty())
    return;
  if (type == "pinClipboard") {
    QString error;
    QImage image;
    auto mime = QGuiApplication::clipboard()->mimeData();
    if (mime->hasUrls()) {
      auto urls = mime->urls();
      if (urls.size() == 1 && urls.first().isLocalFile())
        image = Capture::readImage(urls.first().toLocalFile(), &error);
    } else
      image = Capture::readClipboardImage(&error);
    if (image.isNull())
      report(error.isEmpty() ? QStringLiteral("剪贴板中没有支持的单张图片")
                             : error);
    else if (!pin(image, &error))
      report(error);
  } else if (type == "togglePins") {
    if (pins.isEmpty())
      return;
    hidden = !hidden;
    for (auto p : pins)
      if (p)
        p->setVisible(!hidden);
  } else if (type == "restorePin") {
    if (!closedPin) {
      report(QStringLiteral("没有可恢复的贴图"));
      return;
    }
    auto record = std::move(*closedPin);
    closedPin.reset();
    QString error;
    if (pin(record.document, &error)) {
      pins.last()->restoreView(record.view);
    } else {
      closedPin = std::move(record);
      report(error);
    }
  } else if (type == "configureCaptureSave") {
    QWidget owner;
    Capture::configureSaveDirectory(&owner, settingsPath);
  }
}
void CaptureEngine::capture(QJsonObject m) {
  auto id = m["sessionId"].toString();
  if (!QRegularExpression("^[a-f0-9-]{36}$").match(id).hasMatch())
    return;
  session = id;
  Capture::Feedback::dismissBeforeCapture();
  QString error;
  qint64 total = 0;
  for (auto p : pins)
    if (p)
      total += p->memoryCost();
  if (closedPin)
    total += closedPin->document.memoryCost();
  const auto screens = QGuiApplication::screens();
  Capture::DesktopLayout layout;
  qint64 frameBytes = 0, largestFrame = 0;
  for (auto screen : screens) {
    const auto bounds = Capture::nativeScreenRect(screen);
    if (!Capture::validImageSize(bounds.size())) {
      report(QStringLiteral("无法读取显示器尺寸或单屏图像超出 128 MiB 上限"));
      finish("failed");
      return;
    }
    layout.monitors << Capture::DesktopMonitor{bounds, screen->geometry()};
    const qint64 bytes = qint64(bounds.width()) * bounds.height() * 4;
    frameBytes += bytes;
    largestFrame = std::max(largestFrame, bytes);
  }
  const auto bounds = layout.bounds();
  const qint64 canvasBytes = qint64(bounds.width()) * bounds.height() * 4;
  if (!Capture::validImageSize(bounds.size()) ||
      total + frameBytes + std::max(canvasBytes, largestFrame) >
          Capture::MaxTotalBytes) {
    report(QStringLiteral("桌面合成图像超出 128 MiB 或与贴图合计超出 512 "
                          "MiB，请减少屏幕分辨率或销毁部分贴图"));
    finish("failed");
    return;
  }
  QVector<QImage> frames;
  for (auto screen : screens) {
    auto image = Capture::captureDesktop(screen, &error);
    if (image.isNull()) {
      report(error.isEmpty() ? QStringLiteral("无法捕获桌面图像") : error);
      finish("failed");
      return;
    }
    frames.push_back(image);
  }
  auto image = Capture::composeDesktop(layout, frames, &error);
  frames.clear();
  if (image.isNull()) {
    report(error);
    finish("failed");
    return;
  }
  // Freeze every monitor before showing one continuous native-pixel canvas.
  {
    auto home = QGuiApplication::screenAt(QCursor::pos());
    auto overlay =
        new CaptureOverlay(home ? home : QGuiApplication::primaryScreen(),
                           image, m["origin"].toString(), layout, settingsPath);
    overlays.push_back(overlay);
    overlay->annotations->allowAllocation = [this](qint64 extra) {
      qint64 bytes = extra;
      for (auto o : overlays)
        if (o)
          bytes += o->document.memoryCost();
      for (auto p : pins)
        if (p)
          bytes += p->memoryCost();
      if (closedPin)
        bytes += closedPin->document.memoryCost();
      return bytes <= Capture::MaxTotalBytes;
    };
    if (layout.signature() == lastScreen && image.size() == lastImageSize)
      overlay->recalledSelection = lastArea;
    overlay->claim = [this](CaptureOverlay *o) {
      if (selected && selected != o)
        return false;
      selected = o;
      return true;
    };
    overlay->clearClaim = [this] { selected = nullptr; };
    overlay->cancel = [this] { finish("cancelled"); };
    overlay->output = [this, overlay](QString action, QImage image) {
      output(overlay, action, image);
    };
  }
  for (auto o : overlays)
    if (o) {
      o->showDesktop();
      if (!o->placementValid) {
        report(QStringLiteral("无法覆盖当前桌面布局，请重新截图"));
        finish("failed");
        return;
      }
      o->raise();
      o->activateWindow();
      o->setFocus();
    }
  QJsonArray displays;
  for (auto monitor : layout.monitors) {
    auto rect = [](QRect r) {
      return QJsonArray{r.x(), r.y(), r.width(), r.height()};
    };
    displays.append(QJsonObject{{"physical", rect(monitor.physical)},
                                {"logical", rect(monitor.logical)}});
  }
  send({{"type", "captureReady"},
        {"sessionId", session},
        {"displays", displays}});
}
void CaptureEngine::finish(QString status) {
  if (session.isEmpty())
    return;
  auto id = session;
  if (selected &&
      QStringList{"copied", "saved", "pinned", "delivered"}.contains(status)) {
    lastArea = selected->selection;
    lastScreen = selected->desktopSignature();
    lastImageSize = selected->document.base.size();
  }
  session.clear();
  delivery.clear();
  busy = false;
  selected = nullptr;
  for (auto o : overlays)
    if (o)
      o->close();
  overlays.clear();
  send({{"type", "finished"}, {"sessionId", id}, {"status", status}});
}
bool CaptureEngine::pin(QImage image, QString *error) {
  Capture::ImageDocument document;
  document.base = std::move(image);
  return pin(std::move(document), error);
}
bool CaptureEngine::pin(Capture::ImageDocument document, QString *error,
                        QRect geometry, QScreen *screen, QRect nativeGeometry) {
  qint64 bytes = document.memoryCost();
  if (!document.strokes.isEmpty() || !document.archivedLayer.isNull() ||
      !document.transform.isIdentity())
    bytes += document.base.sizeInBytes();
  if (closedPin)
    bytes += closedPin->document.memoryCost();
  for (auto p : pins)
    if (p)
      bytes += p->memoryCost();
  if (!Capture::validImageSize(document.base.size()) ||
      pins.size() + (closedPin ? 1 : 0) >= 10 ||
      bytes > Capture::MaxTotalBytes) {
    *error = QStringLiteral("贴图上限：10 张、总计 512 MiB，单张 128 MiB");
    return false;
  }
  auto window =
      new PinWindow(std::move(document), settingsPath, geometry, screen);
  if (!nativeGeometry.isEmpty()) {
    window->show();
    if (!window->placeAtPhysicalGeometry(nativeGeometry)) {
      delete window;
      *error = QStringLiteral("贴图定位失败，请重试或保存图片");
      return false;
    }
  }
  pins.push_back(window);
  window->annotations->allowAllocation = [this](qint64 extra) {
    qint64 bytes = extra;
    for (auto p : pins)
      if (p)
        bytes += p->memoryCost();
    if (closedPin)
      bytes += closedPin->document.memoryCost();
    return bytes <= Capture::MaxTotalBytes;
  };
  window->closing = [this](PinWindow *p, bool destroy) {
    if (!destroy)
      closedPin = ClosedPin{p->document, p->viewState()};
  };
  connect(window, &QObject::destroyed, this, [this, window] {
    // QWidget destruction can emit destroyed before its QPointer clears.
    pins.removeIf(
        [window](auto p) { return p.isNull() || p.data() == window; });
    send({{"type", "pins"}, {"count", int(pins.size())}});
  });
  hidden = false;
  for (auto p : pins)
    if (p)
      p->show();
  send({{"type", "pins"}, {"count", int(pins.size())}});
  return true;
}
void CaptureEngine::output(CaptureOverlay *source, QString action,
                           QImage image) {
  if (busy)
    return;
  busy = true;
  QString error;
  if (action == "copy") {
    if (Capture::writeClipboardImage(image, &error)) {
      const auto near = QCursor::pos();
      finish("copied");
      feedback.showMessage(QStringLiteral("已复制到剪贴板"), near);
    } else {
      busy = false;
      source->showError(error);
    }
    return;
  }
  if (action == "save" || action == "quickSave") {
    QString savedPath;
    QPointer<CaptureOverlay> guard(source);
    const auto savingSession = session;
    const bool saved = Capture::saveWithDialog(
        source, image, action == "quickSave", settingsPath, &error, &savedPath);
    // A modal dialog pumps IPC and display/lock events. Cancellation may have
    // already destroyed its parent or started a different capture.
    if (!guard || session != savingSession)
      return;
    if (!saved && error.isEmpty()) {
      busy = false;
      return;
    }
    if (saved) {
      finish("saved");
      feedback.showMessage(QStringLiteral("已保存\n%1").arg(savedPath),
                           QCursor::pos(), 4000);
      return;
    }
  } else if (action == "pin") {
    if (pin(source->document.cropped(source->selection), &error,
            source->selectionGeometry(), source->selectionScreen(),
            source->selectionPhysicalGeometry())) {
      finish("pinned");
      return;
    }
  } else {
    delivery = QUuid::createUuid().toString(QUuid::WithoutBraces);
    auto path = QDir(root).filePath(session + "/" + delivery + ".png");
    if (Capture::saveImage(image, path, &error)) {
      for (auto o : overlays)
        if (o)
          o->hide();
      send({{"type", "output"},
            {"sessionId", session},
            {"deliveryId", delivery},
            {"action", action},
            {"width", image.width()},
            {"height", image.height()}});
      return;
    }
    delivery.clear();
  }
  busy = false;
  source->showError(error);
}
