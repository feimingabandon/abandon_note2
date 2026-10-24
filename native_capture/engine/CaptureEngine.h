#pragma once
#include "CaptureFeedback.h"
#include "CaptureOverlay.h"
#include "PinWindow.h"
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QObject>
#include <QPointer>
#include <optional>

class CaptureEngine : public QObject {
  Q_OBJECT
public:
  CaptureEngine(QString pipe, QString token, QString root);
  ~CaptureEngine() override;

private:
  friend class UiTest;
  QLocalServer server;
  QPointer<QLocalSocket> socket;
  QPointer<QLocalSocket> peerSocket;
  void *peerProcess = nullptr; // Owned Win32 process HANDLE; never a pipe HANDLE.
  quint32 peerPid = 0;
  quint64 socketGeneration = 0, peerGeneration = 0, sessionGeneration = 0;
  QByteArray input;
  QString token, root, session, delivery;
  bool authenticated = false, hidden = false, busy = false;
  QVector<QPointer<CaptureOverlay>> overlays;
  QVector<QPointer<PinWindow>> pins;
  QPointer<CaptureOverlay> selected;
  struct ClosedPin {
    Capture::ImageDocument document;
    PinWindow::ViewState view;
  };
  std::optional<ClosedPin> closedPin;
  QRect lastArea;
  QString lastScreen;
  QSize lastImageSize;
  QString settingsPath;
  Capture::Feedback feedback;
  void revokePeerIdentity();
  void bindPeerIdentity();
  bool grantPeerForeground(const QString &expectedSession,
                           const QString &reason,
                           QJsonObject *foregroundHandoff = nullptr);
  void send(QJsonObject message);
  void receive(QJsonObject message);
  void capture(QJsonObject message);
  void finish(QString status,
              std::optional<QJsonObject> foregroundHandoff = std::nullopt);
  void output(CaptureOverlay *source, QString action, QImage image);
  bool pin(QImage image, QString *error);
  bool pin(Capture::ImageDocument document, QString *error, QRect geometry = {},
           QScreen *screen = nullptr, QRect nativeGeometry = {});
  void report(QString error);
};
