/**
 * blur_effects.h — 精简版 Win2D 效果描述类（header-only）
 *
 * 来源：改编自 Microsoft 官方 microsoft.ui.composition.effects_impl.h
 *       https://github.com/microsoft/Windows.UI.Composition-Win32-Samples
 *
 * 包含：
 *   - GaussianBlurEffect  (CLSID_D2D1GaussianBlur)    // 高斯模糊，可由 Composition 属性实时调节
 *   - BlendEffect  (CLSID_D2D1Blend)                  // 混合
 *   - OpacityEffect (CLSID_D2D1Opacity)               // 通透度
 *   - ColorSourceEffect (CLSID_D2D1Flood)             // 纯色源（自行实现）
 */

#pragma once

#include <wrl.h>
#include <d2d1_1.h>
#include <d2d1effects_2.h>
#include <Windows.Graphics.Effects.h>
#include <Windows.Graphics.Effects.Interop.h>
#include <Windows.UI.h>

namespace Microsoft {
namespace UI {
namespace Composition {
namespace Effects {

// ---- 枚举 ----
typedef enum EffectBorderMode {
    EffectBorderMode_Soft = 0,
    EffectBorderMode_Hard = 1
} EffectBorderMode;

typedef enum EffectOptimization {
    EffectOptimization_Speed = 0,
    EffectOptimization_Balanced = 1,
    EffectOptimization_Quality = 2
} EffectOptimization;

typedef enum BlendEffectMode {
    BlendEffectMode_Multiply = 0,
    BlendEffectMode_Screen = 1,
    BlendEffectMode_Darken = 2,
    BlendEffectMode_Lighten = 3,
    BlendEffectMode_ColorBurn = 5,
    BlendEffectMode_LinearBurn = 6,
    BlendEffectMode_ColorDodge = 9,
    BlendEffectMode_LinearDodge = 10,
    BlendEffectMode_Overlay = 11,
    BlendEffectMode_SoftLight = 12,
    BlendEffectMode_HardLight = 13,
    BlendEffectMode_Luminosity = 23
} BlendEffectMode;

// ---- COM 接口声明 ----
MIDL_INTERFACE("5673248E-7266-5E49-B2AB-2589D5D875C3")
IBlendEffect : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Mode(BlendEffectMode* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Mode(BlendEffectMode value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Background(ABI::Windows::Graphics::Effects::IGraphicsEffectSource** source) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Background(ABI::Windows::Graphics::Effects::IGraphicsEffectSource* source) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Foreground(ABI::Windows::Graphics::Effects::IGraphicsEffectSource** source) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Foreground(ABI::Windows::Graphics::Effects::IGraphicsEffectSource* source) = 0;
};

MIDL_INTERFACE("25F942C7-7FEE-518A-BA7B-22A0060AF7F6")
IColorSourceEffect : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Color(ABI::Windows::UI::Color* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Color(ABI::Windows::UI::Color value) = 0;
};

MIDL_INTERFACE("A82EC394-6734-5830-9123-2C82B27DD3C0")
IGaussianBlurEffect : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_BlurAmount(float* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_BlurAmount(float value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Optimization(EffectOptimization* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Optimization(EffectOptimization value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_BorderMode(EffectBorderMode* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_BorderMode(EffectBorderMode value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Source(ABI::Windows::Graphics::Effects::IGraphicsEffectSource** source) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Source(ABI::Windows::Graphics::Effects::IGraphicsEffectSource* source) = 0;
};

MIDL_INTERFACE("94B6AD75-C540-51B8-A9D1-544174ADC68D")
IOpacityEffect : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Opacity(float* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Opacity(float value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Source(ABI::Windows::Graphics::Effects::IGraphicsEffectSource** source) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Source(ABI::Windows::Graphics::Effects::IGraphicsEffectSource* source) = 0;
};

MIDL_INTERFACE("82B1D9F3-BBDC-527D-8D7B-3E68B7F2F1F8")
ISaturationEffect : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Saturation(float* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Saturation(float value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Source(ABI::Windows::Graphics::Effects::IGraphicsEffectSource** source) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_Source(ABI::Windows::Graphics::Effects::IGraphicsEffectSource* source) = 0;
};

// ---- 基类模板 ----
template<typename TEffectInterface>
class EffectBase : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::WinRtClassicComMix>,
    ABI::Windows::Graphics::Effects::IGraphicsEffect,
    ABI::Windows::Graphics::Effects::IGraphicsEffectSource,
    ABI::Windows::Graphics::Effects::IGraphicsEffectD2D1Interop,
    TEffectInterface>
{
protected:
    typedef ABI::Windows::UI::Color UIColor;
    typedef ABI::Windows::Foundation::IPropertyValue IPropertyValue;
    typedef ABI::Windows::Foundation::IPropertyValueStatics IPropertyValueStatics;
    typedef ABI::Windows::Graphics::Effects::IGraphicsEffectSource IGraphicsEffectSource;

public:
    // IGraphicsEffect
    IFACEMETHODIMP get_Name(_Out_ HSTRING* name) override { return Name.CopyTo(name); }
    IFACEMETHODIMP put_Name(_In_ HSTRING name) override { return Name.Set(name); }

    // IGraphicsEffectD2D1Interop (default: no sources, no properties)
    IFACEMETHODIMP GetSourceCount(_Out_ UINT* count) override { *count = 0; return S_OK; }
    IFACEMETHODIMP GetPropertyCount(_Out_ UINT* count) override { *count = 0; return S_OK; }
    IFACEMETHODIMP GetSource(UINT, _Outptr_result_maybenull_ IGraphicsEffectSource**) override { return E_INVALIDARG; }
    IFACEMETHODIMP GetProperty(UINT, _Outptr_ IPropertyValue**) override { return E_INVALIDARG; }
    IFACEMETHODIMP GetNamedPropertyMapping(_In_z_ LPCWSTR, _Out_ UINT*, _Out_ ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING*) override { return E_INVALIDARG; }

protected:
    template<typename TFunc>
    static HRESULT UsePropertyFactory(const TFunc& func) {
        Microsoft::WRL::ComPtr<IPropertyValueStatics> factory;
        Microsoft::WRL::Wrappers::HStringReference id{ RuntimeClass_Windows_Foundation_PropertyValue };
        HRESULT hr = GetActivationFactory(id.Get(), &factory);
        return FAILED(hr) ? hr : func(factory.Get());
    }

    struct NamedProperty {
        const wchar_t* Name;
        UINT Index;
        ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING Mapping;
    };

    HRESULT GetNamedPropertyMappingImpl(
        _In_count_(count) const NamedProperty* props, UINT count,
        _In_z_ LPCWSTR name, _Out_ UINT* index,
        _Out_ ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING* mapping)
    {
        for (UINT i = 0; i < count; ++i) {
            if (_wcsicmp(name, props[i].Name) == 0) {
                *index = props[i].Index;
                *mapping = props[i].Mapping;
                return S_OK;
            }
        }
        return E_INVALIDARG;
    }

public:
    Microsoft::WRL::Wrappers::HString Name;
};

// ---- 宏 ----
#define DECLARE_D2D_GUID(Guid) \
    IFACEMETHODIMP GetEffectId(_Out_ GUID* id) override { *id = Guid; return S_OK; }

#define DECLARE_POD_PROPERTY(Name, Type, InitialValue, Condition) \
    Type Name = InitialValue; \
    IFACEMETHODIMP get_##Name(_Out_ Type* value) override { *value = Name; return S_OK; } \
    IFACEMETHODIMP put_##Name(Type value) override { \
        if (!(Condition)) return E_INVALIDARG; \
        Name = value; return S_OK; \
    }

#define DECLARE_SOURCE(Name) \
    Microsoft::WRL::ComPtr<IGraphicsEffectSource> Name; \
    IFACEMETHODIMP get_##Name(_Outptr_result_maybenull_ IGraphicsEffectSource** value) override { return Name.CopyTo(value); } \
    IFACEMETHODIMP put_##Name(_In_ IGraphicsEffectSource* value) override { Name = value; return S_OK; }

#define DECLARE_SINGLE_SOURCE(Name) \
    DECLARE_SOURCE(Name) \
    IFACEMETHODIMP GetSourceCount(_Out_ UINT* count) override { *count = 1; return S_OK; } \
    IFACEMETHODIMP GetSource(UINT index, _Outptr_result_maybenull_ IGraphicsEffectSource** source) override { \
        return index == 0 ? Name.CopyTo(source) : E_INVALIDARG; \
    }

#define DECLARE_DUAL_SOURCES(Name1, Name2) \
    DECLARE_SOURCE(Name1) DECLARE_SOURCE(Name2) \
    IFACEMETHODIMP GetSourceCount(_Out_ UINT* count) override { *count = 2; return S_OK; } \
    IFACEMETHODIMP GetSource(UINT index, _Outptr_result_maybenull_ IGraphicsEffectSource** source) override { \
        return index == 0 ? Name1.CopyTo(source) : index == 1 ? Name2.CopyTo(source) : E_INVALIDARG; \
    }

#define DECLARE_NAMED_PROPERTY_MAPPING(...) \
    IFACEMETHODIMP GetNamedPropertyMapping(_In_z_ LPCWSTR name, _Out_ UINT* index, \
        _Out_ ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING* mapping) override { \
        static const NamedProperty s_Props[] = { __VA_ARGS__ }; \
        return GetNamedPropertyMappingImpl(s_Props, _countof(s_Props), name, index, mapping); \
    }

// ============================================================
// GaussianBlurEffect — 高斯模糊（创建管线时会由 BlurConfig 覆盖）
// ============================================================
class GaussianBlurEffect WrlFinal : public EffectBase<IGaussianBlurEffect>
{
    InspectableClass(L"GaussianBlurEffect", BaseTrust);

public:
    DECLARE_D2D_GUID(CLSID_D2D1GaussianBlur);
    DECLARE_SINGLE_SOURCE(Source);
    DECLARE_POD_PROPERTY(BlurAmount, float, 15.0f, value >= 0.0f && value <= 250.0f);
    DECLARE_POD_PROPERTY(Optimization, EffectOptimization, EffectOptimization_Balanced, true);
    DECLARE_POD_PROPERTY(BorderMode, EffectBorderMode, EffectBorderMode_Hard, true);
    DECLARE_NAMED_PROPERTY_MAPPING(
        { L"BlurAmount", D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT },
        { L"Optimization", D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT },
        { L"BorderMode", D2D1_GAUSSIANBLUR_PROP_BORDER_MODE, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT });

    IFACEMETHODIMP GetPropertyCount(_Out_ UINT* count) override { *count = 3; return S_OK; }
    IFACEMETHODIMP GetProperty(UINT index, _Outptr_ IPropertyValue** value) override {
        return UsePropertyFactory([=](IPropertyValueStatics* s) {
            switch (index) {
            case D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION: return s->CreateSingle(BlurAmount, (IInspectable**)value);
            case D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION: return s->CreateUInt32(Optimization, (IInspectable**)value);
            case D2D1_GAUSSIANBLUR_PROP_BORDER_MODE: return s->CreateUInt32(BorderMode, (IInspectable**)value);
            default: return E_INVALIDARG;
            }
        });
    }
};

// ============================================================
// BlendEffect — 混合（默认 Luminosity 模式）
// ============================================================
class BlendEffect WrlFinal : public EffectBase<IBlendEffect>
{
    InspectableClass(L"BlendEffect", BaseTrust);

public:
    DECLARE_D2D_GUID(CLSID_D2D1Blend);
    DECLARE_DUAL_SOURCES(Background, Foreground);
    DECLARE_POD_PROPERTY(Mode, BlendEffectMode, BlendEffectMode_Luminosity, true);
    DECLARE_NAMED_PROPERTY_MAPPING(
        { L"Mode", D2D1_BLEND_PROP_MODE, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT });

    IFACEMETHODIMP GetPropertyCount(_Out_ UINT* count) override { *count = 1; return S_OK; }
    IFACEMETHODIMP GetProperty(UINT index, _Outptr_ IPropertyValue** value) override {
        return UsePropertyFactory([=](IPropertyValueStatics* s) {
            switch (index) {
            case D2D1_BLEND_PROP_MODE: return s->CreateUInt32(Mode, (IInspectable**)value);
            default: return E_INVALIDARG;
            }
        });
    }
};

// ============================================================
// OpacityEffect — 通透度控制
// ============================================================
class OpacityEffect WrlFinal : public EffectBase<IOpacityEffect>
{
    InspectableClass(L"OpacityEffect", BaseTrust);

public:
    DECLARE_D2D_GUID(CLSID_D2D1Opacity);
    DECLARE_SINGLE_SOURCE(Source);
    DECLARE_POD_PROPERTY(Opacity, float, 0.6f, value >= 0.0f && value <= 1.0f);
    DECLARE_NAMED_PROPERTY_MAPPING(
        { L"Opacity", D2D1_OPACITY_PROP_OPACITY, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT });

    IFACEMETHODIMP GetPropertyCount(_Out_ UINT* count) override { *count = 1; return S_OK; }
    IFACEMETHODIMP GetProperty(UINT index, _Outptr_ IPropertyValue** value) override {
        return UsePropertyFactory([=](IPropertyValueStatics* s) {
            switch (index) {
            case D2D1_OPACITY_PROP_OPACITY: return s->CreateSingle(Opacity, (IInspectable**)value);
            default: return E_INVALIDARG;
            }
        });
    }
};

// ============================================================
// ColorSourceEffect — 纯色源（CLSID_D2D1Flood）
// 实现 IColorSourceEffect 接口，输出 D2D Flood 效果
// ============================================================
class ColorSourceEffect WrlFinal : public EffectBase<IColorSourceEffect>
{
    InspectableClass(L"ColorSourceEffect", BaseTrust);

public:
    DECLARE_D2D_GUID(CLSID_D2D1Flood);
    DECLARE_POD_PROPERTY(Color, ABI::Windows::UI::Color,
        (ABI::Windows::UI::Color{ 255, 255, 255, 255 }), true);
    DECLARE_NAMED_PROPERTY_MAPPING(
        { L"Color", D2D1_FLOOD_PROP_COLOR, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_COLOR_TO_VECTOR4 });

    IFACEMETHODIMP GetPropertyCount(_Out_ UINT* count) override { *count = 1; return S_OK; }
    IFACEMETHODIMP GetProperty(UINT index, _Outptr_ IPropertyValue** value) override {
        return UsePropertyFactory([=](IPropertyValueStatics* s) {
            switch (index) {
            case D2D1_FLOOD_PROP_COLOR: {
                float color4[4] = {
                    Color.R / 255.0f, Color.G / 255.0f,
                    Color.B / 255.0f, Color.A / 255.0f
                };
                return s->CreateSingleArray(4, color4, (IInspectable**)value);
            }
            default: return E_INVALIDARG;
            }
        });
    }
};

// ============================================================
// SaturationEffect — 饱和度（默认 1.8 模拟苹果风格）
// ============================================================
class SaturationEffect WrlFinal : public EffectBase<ISaturationEffect>
{
    InspectableClass(L"SaturationEffect", BaseTrust);

public:
    DECLARE_D2D_GUID(CLSID_D2D1Saturation);
    DECLARE_SINGLE_SOURCE(Source);
    DECLARE_POD_PROPERTY(Saturation, float, 1.8f, value >= 0.0f && value <= 2.0f);
    DECLARE_NAMED_PROPERTY_MAPPING(
        { L"Saturation", D2D1_SATURATION_PROP_SATURATION, ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT });

    IFACEMETHODIMP GetPropertyCount(_Out_ UINT* count) override { *count = 1; return S_OK; }
    IFACEMETHODIMP GetProperty(UINT index, _Outptr_ IPropertyValue** value) override {
        return UsePropertyFactory([=](IPropertyValueStatics* s) {
            switch (index) {
            case D2D1_SATURATION_PROP_SATURATION: return s->CreateSingle(Saturation, (IInspectable**)value);
            default: return E_INVALIDARG;
            }
        });
    }
};

} // namespace Effects
} // namespace Composition
} // namespace UI
} // namespace Microsoft
