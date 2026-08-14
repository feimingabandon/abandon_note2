#include "reveal_handle_renderer.h"
#include "reveal_handle_resource.h"

#include <algorithm>
#include <cmath>
#include <d2d1.h>
#include <d2d1helper.h>
#include <dwrite_3.h>
#include <wincodec.h>
#include <wrl/client.h>

namespace WindowMotionEdgeMonitor {
namespace {

using Microsoft::WRL::ComPtr;

constexpr float kRingRevolutionMs = 4200.0f;
constexpr float kPi = 3.14159265358979323846f;
constexpr int kTrailSegmentCount = 64;
constexpr float kTrailSweepDegrees = 242.0f;
constexpr float kCornerRadiusDip = 16.0f;
constexpr wchar_t kEmbeddedFontFamily[] = L"OPPOSans";

void ModuleAddressMarker() {}

HMODULE GetCurrentModule() {
    HMODULE module = nullptr;
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&ModuleAddressMarker), &module);
    return module;
}

bool LoadResourceBytes(int resourceId, const BYTE*& data, DWORD& size) {
    data = nullptr;
    size = 0;
    const HMODULE module = GetCurrentModule();
    const HRSRC resource = module
        ? FindResourceW(module, MAKEINTRESOURCEW(resourceId), MAKEINTRESOURCEW(10))
        : nullptr;
    if (!resource) return false;
    const HGLOBAL loaded = LoadResource(module, resource);
    size = SizeofResource(module, resource);
    data = loaded ? static_cast<const BYTE*>(LockResource(loaded)) : nullptr;
    return data && size > 0;
}

D2D1_POINT_2F PointOnCircle(D2D1_POINT_2F center, float radius, float degrees) {
    const float radians = degrees * kPi / 180.0f;
    return D2D1::Point2F(
        center.x + std::cos(radians) * radius,
        center.y + std::sin(radians) * radius);
}

float Lerp(float start, float finish, float amount) {
    return start + (finish - start) * amount;
}

} // namespace

struct RevealHandleRenderer::Impl {
    ComPtr<ID2D1Factory> d2dFactory;
    ComPtr<IDWriteFactory> writeFactory;
    ComPtr<IDWriteFactory3> writeFactory3;
    ComPtr<IDWriteFactory5> writeFactory5;
    ComPtr<IDWriteInMemoryFontFileLoader> fontLoader;
    ComPtr<IDWriteFontCollection1> privateFontCollection;
    ComPtr<IWICImagingFactory> wicFactory;
    ComPtr<IWICFormatConverter> avatarSource;
    ComPtr<ID2D1DCRenderTarget> target;
    ComPtr<ID2D1Bitmap> avatarBitmap;
    ComPtr<ID2D1StrokeStyle> roundedStroke;
    ComPtr<IDWriteTextFormat> horizontalText;
    ComPtr<IDWriteTextFormat> verticalText;
    HDC memoryDc = nullptr;
    HBITMAP surfaceBitmap = nullptr;
    HGDIOBJ previousBitmap = nullptr;
    void* surfaceBits = nullptr;
    UINT surfaceWidth = 0;
    UINT surfaceHeight = 0;
    UINT targetDpi = 96;
    bool embeddedFontReady = false;
    bool fontLoaderRegistered = false;

    ~Impl() {
        DiscardTarget();
        horizontalText.Reset();
        verticalText.Reset();
        privateFontCollection.Reset();
        if (fontLoaderRegistered && writeFactory && fontLoader) {
            writeFactory->UnregisterFontFileLoader(fontLoader.Get());
        }
        fontLoader.Reset();
    }

    bool LoadAvatarSource() {
        const BYTE* data = nullptr;
        DWORD size = 0;
        if (!LoadResourceBytes(IDR_REVEAL_AVATAR_PNG, data, size)) return false;

        ComPtr<IWICStream> stream;
        if (FAILED(wicFactory->CreateStream(&stream)) ||
            FAILED(stream->InitializeFromMemory(const_cast<BYTE*>(data), size))) {
            return false;
        }
        ComPtr<IWICBitmapDecoder> decoder;
        if (FAILED(wicFactory->CreateDecoderFromStream(
                stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder))) {
            return false;
        }
        ComPtr<IWICBitmapFrameDecode> frame;
        if (FAILED(decoder->GetFrame(0, &frame))) return false;
        ComPtr<IWICFormatConverter> converter;
        if (FAILED(wicFactory->CreateFormatConverter(&converter)) ||
            FAILED(converter->Initialize(
                frame.Get(), GUID_WICPixelFormat32bppPBGRA,
                WICBitmapDitherTypeNone, nullptr, 0.0,
                WICBitmapPaletteTypeCustom))) {
            return false;
        }
        avatarSource = converter;
        return true;
    }

    bool CreatePrivateFontCollection() {
        const BYTE* data = nullptr;
        DWORD size = 0;
        if (!writeFactory3 || !writeFactory5 ||
            !LoadResourceBytes(IDR_REVEAL_OPPOSANS_TTF, data, size) ||
            FAILED(writeFactory5->CreateInMemoryFontFileLoader(&fontLoader)) ||
            FAILED(writeFactory->RegisterFontFileLoader(fontLoader.Get()))) {
            return false;
        }
        fontLoaderRegistered = true;

        ComPtr<IDWriteFontFile> fontFile;
        ComPtr<IDWriteFontSetBuilder1> builder;
        ComPtr<IDWriteFontSet> fontSet;
        if (FAILED(fontLoader->CreateInMemoryFontFileReference(
                writeFactory.Get(), data, size, nullptr, &fontFile)) ||
            FAILED(writeFactory5->CreateFontSetBuilder(&builder)) ||
            FAILED(builder->AddFontFile(fontFile.Get())) ||
            FAILED(builder->CreateFontSet(&fontSet)) ||
            FAILED(writeFactory3->CreateFontCollectionFromFontSet(
                fontSet.Get(), &privateFontCollection))) {
            return false;
        }
        UINT32 familyIndex = 0;
        BOOL familyExists = FALSE;
        return SUCCEEDED(privateFontCollection->FindFamilyName(
                   kEmbeddedFontFamily, &familyIndex, &familyExists)) &&
            familyExists;
    }

    bool CreateTextFormat(
        float size, IDWriteTextFormat** output, DWRITE_WORD_WRAPPING wrapping) {
        ComPtr<IDWriteTextFormat> format;
        const wchar_t* family = embeddedFontReady
            ? kEmbeddedFontFamily : L"Microsoft YaHei UI";
        IDWriteFontCollection* collection = embeddedFontReady
            ? privateFontCollection.Get() : nullptr;
        HRESULT result = writeFactory->CreateTextFormat(
            family, collection, embeddedFontReady
                ? DWRITE_FONT_WEIGHT_MEDIUM : DWRITE_FONT_WEIGHT_SEMI_BOLD,
            DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
            size, L"zh-CN", &format);
        if (FAILED(result)) {
            embeddedFontReady = false;
            result = writeFactory->CreateTextFormat(
                L"Microsoft YaHei UI", nullptr, DWRITE_FONT_WEIGHT_SEMI_BOLD,
                DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                size, L"zh-CN", &format);
        }
        if (FAILED(result)) return false;
        format->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
        format->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
        format->SetWordWrapping(wrapping);
        *output = format.Detach();
        return true;
    }

    void DiscardTarget() {
        avatarBitmap.Reset();
        target.Reset();
        if (memoryDc && previousBitmap) {
            SelectObject(memoryDc, previousBitmap);
        }
        previousBitmap = nullptr;
        if (surfaceBitmap) DeleteObject(surfaceBitmap);
        if (memoryDc) DeleteDC(memoryDc);
        surfaceBitmap = nullptr;
        memoryDc = nullptr;
        surfaceBits = nullptr;
        surfaceWidth = 0;
        surfaceHeight = 0;
        targetDpi = 96;
    }

    bool EnsureTarget(UINT width, UINT height, UINT dpi) {
        width = std::max<UINT>(1, width);
        height = std::max<UINT>(1, height);
        if (target && surfaceWidth == width && surfaceHeight == height && targetDpi == dpi) {
            return true;
        }

        DiscardTarget();
        memoryDc = CreateCompatibleDC(nullptr);
        if (!memoryDc) return false;
        BITMAPINFO bitmapInfo{};
        bitmapInfo.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bitmapInfo.bmiHeader.biWidth = static_cast<LONG>(width);
        bitmapInfo.bmiHeader.biHeight = -static_cast<LONG>(height);
        bitmapInfo.bmiHeader.biPlanes = 1;
        bitmapInfo.bmiHeader.biBitCount = 32;
        bitmapInfo.bmiHeader.biCompression = BI_RGB;
        surfaceBitmap = CreateDIBSection(
            memoryDc, &bitmapInfo, DIB_RGB_COLORS, &surfaceBits, nullptr, 0);
        if (!surfaceBitmap || !surfaceBits) {
            DiscardTarget();
            return false;
        }
        previousBitmap = SelectObject(memoryDc, surfaceBitmap);

        const D2D1_RENDER_TARGET_PROPERTIES properties = D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_DEFAULT,
            D2D1::PixelFormat(
                DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
            static_cast<float>(dpi), static_cast<float>(dpi),
            D2D1_RENDER_TARGET_USAGE_GDI_COMPATIBLE,
            D2D1_FEATURE_LEVEL_DEFAULT);
        const RECT client{0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
        if (FAILED(d2dFactory->CreateDCRenderTarget(&properties, &target)) ||
            FAILED(target->BindDC(memoryDc, &client)) ||
            FAILED(target->CreateBitmapFromWicBitmap(
                avatarSource.Get(), nullptr, &avatarBitmap))) {
            DiscardTarget();
            return false;
        }
        surfaceWidth = width;
        surfaceHeight = height;
        targetDpi = dpi;
        return true;
    }

    bool EnsureTarget(HWND hwnd, UINT dpi) {
        RECT client{};
        if (!GetClientRect(hwnd, &client)) return false;
        return EnsureTarget(
            static_cast<UINT>(std::max<LONG>(1, client.right - client.left)),
            static_cast<UINT>(std::max<LONG>(1, client.bottom - client.top)),
            dpi);
    }

    void DrawHandleSurface(int side, const D2D1_SIZE_F& size) {
        ComPtr<ID2D1SolidColorBrush> background;
        if (FAILED(target->CreateSolidColorBrush(
                D2D1::ColorF(0x121315, 0.965f), &background))) return;
        const D2D1_ROUNDED_RECT rounded = D2D1::RoundedRect(
            D2D1::RectF(0.0f, 0.0f, size.width, size.height),
            kCornerRadiusDip, kCornerRadiusDip);
        target->FillRoundedRectangle(rounded, background.Get());
        if (side == -1) {
            target->FillRectangle(
                D2D1::RectF(0.0f, 0.0f, kCornerRadiusDip, size.height), background.Get());
        } else if (side == 1) {
            target->FillRectangle(
                D2D1::RectF(size.width - kCornerRadiusDip, 0.0f, size.width, size.height),
                background.Get());
        } else if (side == -2) {
            target->FillRectangle(
                D2D1::RectF(0.0f, 0.0f, size.width, kCornerRadiusDip), background.Get());
        } else {
            target->FillRectangle(
                D2D1::RectF(0.0f, size.height - kCornerRadiusDip, size.width, size.height),
                background.Get());
        }
    }

    void DrawLightTrail(D2D1_POINT_2F center, float radius, float headAngle) {
        ComPtr<ID2D1SolidColorBrush> glowBrush;
        ComPtr<ID2D1SolidColorBrush> coreBrush;
        if (FAILED(target->CreateSolidColorBrush(D2D1::ColorF(0, 0.0f), &glowBrush)) ||
            FAILED(target->CreateSolidColorBrush(D2D1::ColorF(0, 0.0f), &coreBrush))) {
            return;
        }
        const float segmentSweep = kTrailSweepDegrees / kTrailSegmentCount;
        for (int index = 0; index < kTrailSegmentCount; ++index) {
            const float progress = static_cast<float>(index + 1) / kTrailSegmentCount;
            const float eased = std::pow(progress, 1.85f);
            const float startAngle = headAngle - kTrailSweepDegrees + index * segmentSweep;
            const float finishAngle = startAngle + segmentSweep * 1.08f;
            const D2D1_POINT_2F start = PointOnCircle(center, radius, startAngle);
            const D2D1_POINT_2F finish = PointOnCircle(center, radius, finishAngle);

            const float red = Lerp(0x2A / 255.0f, 0xD8 / 255.0f, eased);
            const float green = Lerp(0xCB / 255.0f, 1.0f, eased);
            const float blue = Lerp(0x62 / 255.0f, 0xE2 / 255.0f, eased);
            const float coreAlpha = 0.96f * eased;
            glowBrush->SetColor(D2D1::ColorF(red, green, blue, coreAlpha * 0.14f));
            coreBrush->SetColor(D2D1::ColorF(red, green, blue, coreAlpha));
            target->DrawLine(start, finish, glowBrush.Get(), 3.6f, roundedStroke.Get());
            target->DrawLine(start, finish, coreBrush.Get(), 1.5f, roundedStroke.Get());
        }
    }

    bool Present(HWND hwnd) {
        RECT windowRect{};
        if (!GetWindowRect(hwnd, &windowRect)) return false;
        POINT destination{windowRect.left, windowRect.top};
        POINT source{0, 0};
        SIZE size{static_cast<LONG>(surfaceWidth), static_cast<LONG>(surfaceHeight)};
        BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
        HDC screenDc = GetDC(nullptr);
        const BOOL updated = UpdateLayeredWindow(
            hwnd, screenDc, &destination, &size, memoryDc, &source,
            0, &blend, ULW_ALPHA);
        if (screenDc) ReleaseDC(nullptr, screenDc);
        return updated != FALSE;
    }

    bool DrawFrame(int side, std::uint64_t animationStartedAt) {
        RECT client{0, 0, static_cast<LONG>(surfaceWidth), static_cast<LONG>(surfaceHeight)};
        if (FAILED(target->BindDC(memoryDc, &client))) return false;

        const bool vertical = side == -1 || side == 1;
        const D2D1_SIZE_F size = target->GetSize();
        const D2D1_POINT_2F avatarCenter = vertical
            ? D2D1::Point2F(size.width / 2.0f, 25.5f)
            : D2D1::Point2F(23.0f, size.height / 2.0f);
        constexpr float avatarRadius = 12.5f;
        constexpr float avatarFrameRadius = 13.5f;
        constexpr float ringRadius = 15.8f;

        ComPtr<ID2D1SolidColorBrush> avatarFrameBrush;
        ComPtr<ID2D1SolidColorBrush> avatarOutlineBrush;
        ComPtr<ID2D1SolidColorBrush> textBrush;
        if (FAILED(target->CreateSolidColorBrush(
                D2D1::ColorF(0x08090A, 0.84f), &avatarFrameBrush)) ||
            FAILED(target->CreateSolidColorBrush(
                D2D1::ColorF(0x0A0B0D, 0.68f), &avatarOutlineBrush)) ||
            FAILED(target->CreateSolidColorBrush(
                D2D1::ColorF(0xF5F5F7, 0.96f), &textBrush))) {
            return false;
        }

        ComPtr<ID2D1EllipseGeometry> avatarClip;
        ComPtr<ID2D1Layer> avatarLayer;
        if (FAILED(d2dFactory->CreateEllipseGeometry(
                D2D1::Ellipse(avatarCenter, avatarRadius, avatarRadius), &avatarClip)) ||
            FAILED(target->CreateLayer(nullptr, &avatarLayer))) {
            return false;
        }
        const D2D1_RECT_F avatarRect = D2D1::RectF(
            avatarCenter.x - avatarRadius, avatarCenter.y - avatarRadius,
            avatarCenter.x + avatarRadius, avatarCenter.y + avatarRadius);
        const std::uint64_t now = GetTickCount64();
        const float elapsed = static_cast<float>(
            now >= animationStartedAt ? now - animationStartedAt : 0);
        const float headAngle = std::fmod(
            elapsed * 360.0f / kRingRevolutionMs, 360.0f) - 90.0f;

        target->BeginDraw();
        target->SetTransform(D2D1::Matrix3x2F::Identity());
        target->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        target->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        target->Clear(D2D1::ColorF(0, 0.0f));
        DrawHandleSurface(side, size);
        target->FillEllipse(
            D2D1::Ellipse(avatarCenter, avatarFrameRadius, avatarFrameRadius),
            avatarFrameBrush.Get());
        target->PushLayer(
            D2D1::LayerParameters(
                D2D1::InfiniteRect(), avatarClip.Get(),
                D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                D2D1::Matrix3x2F::Identity(), 1.0f, nullptr,
                D2D1_LAYER_OPTIONS_NONE),
            avatarLayer.Get());
        target->DrawBitmap(
            avatarBitmap.Get(), avatarRect, 1.0f,
            D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
        target->PopLayer();
        target->DrawEllipse(
            D2D1::Ellipse(avatarCenter, avatarRadius, avatarRadius),
            avatarOutlineBrush.Get(), 0.75f);
        DrawLightTrail(avatarCenter, ringRadius, headAngle);

        if (vertical) {
            const D2D1_RECT_F firstLine = D2D1::RectF(3.0f, 49.0f, size.width - 3.0f, 69.0f);
            const D2D1_RECT_F secondLine = D2D1::RectF(3.0f, 68.0f, size.width - 3.0f, 88.0f);
            target->DrawText(L"\x70b9\x51fb", 2, verticalText.Get(), firstLine, textBrush.Get());
            target->DrawText(L"\x5c55\x5f00", 2, verticalText.Get(), secondLine, textBrush.Get());
        } else {
            const D2D1_RECT_F textRect = D2D1::RectF(
                45.0f, 3.0f, size.width - 10.0f, size.height - 3.0f);
            target->DrawText(
                L"\x70b9\x51fb\x5c55\x5f00", 4,
                horizontalText.Get(), textRect, textBrush.Get());
        }

        const HRESULT result = target->EndDraw();
        if (result == D2DERR_RECREATE_TARGET) DiscardTarget();
        return SUCCEEDED(result);
    }

    bool Draw(HWND hwnd, int side, UINT dpi, std::uint64_t animationStartedAt) {
        return EnsureTarget(hwnd, dpi) &&
            DrawFrame(side, animationStartedAt) &&
            Present(hwnd);
    }

    bool Prewarm(UINT width, UINT height, int side, UINT dpi) {
        return EnsureTarget(width, height, dpi) &&
            DrawFrame(side, GetTickCount64());
    }
};

RevealHandleRenderer::RevealHandleRenderer() : impl_(std::make_unique<Impl>()) {}
RevealHandleRenderer::~RevealHandleRenderer() = default;

bool RevealHandleRenderer::Initialize() {
    if (!impl_) return false;
    if (FAILED(D2D1CreateFactory(
            D2D1_FACTORY_TYPE_SINGLE_THREADED,
            impl_->d2dFactory.GetAddressOf())) ||
        FAILED(DWriteCreateFactory(
            DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
            reinterpret_cast<IUnknown**>(impl_->writeFactory.GetAddressOf()))) ||
        FAILED(CoCreateInstance(
            CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&impl_->wicFactory))) ||
        !impl_->LoadAvatarSource()) {
        impl_.reset();
        return false;
    }
    impl_->writeFactory.As(&impl_->writeFactory3);
    impl_->writeFactory.As(&impl_->writeFactory5);
    impl_->embeddedFontReady = impl_->CreatePrivateFontCollection();
    D2D1_STROKE_STYLE_PROPERTIES strokeProperties = D2D1::StrokeStyleProperties();
    strokeProperties.startCap = D2D1_CAP_STYLE_ROUND;
    strokeProperties.endCap = D2D1_CAP_STYLE_ROUND;
    if (FAILED(impl_->d2dFactory->CreateStrokeStyle(
            strokeProperties, nullptr, 0, &impl_->roundedStroke)) ||
        !impl_->CreateTextFormat(
            11.0f, &impl_->horizontalText, DWRITE_WORD_WRAPPING_NO_WRAP) ||
        !impl_->CreateTextFormat(
            11.0f, &impl_->verticalText, DWRITE_WORD_WRAPPING_NO_WRAP)) {
        impl_.reset();
        return false;
    }
    return true;
}

bool RevealHandleRenderer::Paint(
    HWND hwnd, int side, UINT dpi, std::uint64_t animationStartedAt) {
    return impl_ && impl_->Draw(hwnd, side, std::max<UINT>(96, dpi), animationStartedAt);
}

bool RevealHandleRenderer::Prewarm(UINT width, UINT height, int side, UINT dpi) {
    return impl_ && impl_->Prewarm(
        width, height, side, std::max<UINT>(96, dpi));
}

bool RevealHandleRenderer::UsesEmbeddedFont() const {
    return impl_ && impl_->embeddedFontReady;
}

void RevealHandleRenderer::DiscardWindowResources() {
    if (impl_) impl_->DiscardTarget();
}

} // namespace WindowMotionEdgeMonitor
