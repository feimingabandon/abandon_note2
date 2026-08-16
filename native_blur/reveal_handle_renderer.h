#pragma once

#include <cstdint>
#include <memory>
#include <windows.h>

namespace WindowMotionEdgeMonitor {

class RevealHandleRenderer final {
public:
    RevealHandleRenderer();
    ~RevealHandleRenderer();

    RevealHandleRenderer(const RevealHandleRenderer&) = delete;
    RevealHandleRenderer& operator=(const RevealHandleRenderer&) = delete;

    bool Initialize();
    bool Prewarm(UINT width, UINT height, int side, UINT dpi);
    bool Paint(HWND hwnd, int side, UINT dpi, std::uint64_t visibleElapsedMs);
    bool UsesEmbeddedFont() const;
    void DiscardWindowResources();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace WindowMotionEdgeMonitor
