"""Local-only QA service using an isolated temporary SQLite DB and image store."""
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
with tempfile.TemporaryDirectory(prefix="abandon-notice-admin-qa-") as directory:
    os.environ.update({
        "ENVIRONMENT": "test", "DATABASE_ENGINE": "sqlite", "BASE_DIR": directory,
        "LOGS_ROOT": directory + "/logs", "NOTICE_IMAGE_ROOT": directory + "/images",
        "NOTICE_IMAGE_PUBLIC_URL": "https://notice-images.test/media/notices",
        "INITIAL_ADMIN_USERNAME": "notice-qa", "INITIAL_ADMIN_PASSWORD": "notice-qa-password",
        "INITIAL_ADMIN_EMAIL": "notice-qa@example.com",
    })
    import uvicorn
    from app import app
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(f"NOTICE_QA_PORT={sock.getsockname()[1]}", flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    def stop_on_input():
        if sys.stdin.readline().strip() == "stop":
            server.should_exit = True
    threading.Thread(target=stop_on_input, daemon=True).start()
    server.run(sockets=[sock])
