# BZZY artwork and celeste theme

`BZZY/Assets.xcassets/BZZYEyes.imageset/eyes.png` is the supplied two-eye PNG,
copied without redrawing, cropping or resampling. The iOS view scales it as a
complete mark and uses screen blending to integrate its black background with
the app surface. The original asset remains byte-identical to the supplied PNG.
The view displays it 25% larger, clipping only unused black side margins.
`FlyMotion.metal` gently distorts the original pixels for pupil tracking, antenna
sway and breathing; it never replaces the compound-eye texture or draws eyelids.
There is no blinking or eye-closing state. Touch targets ease with a speed limit;
the animation clock pauses offscreen/background and ignores long frame gaps.
Reduce Motion disables the distortion and returns to the original still image.
The Xcode Metal toolchain compiles the shader; native macOS previews compile and
load the same source into their own Metal library.

The opaque 1024×1024 `AppIcon.appiconset/AppIcon.png` adapts the supplied
single-eye crop. The inner side is cut at the left edge, with one illuminated eye
and antenna on black. iOS applies the icon mask. The built-in imagegen tool
prepared this bitmap, followed by standard resizing to the required icon size.
The native preview tool copies this actual icon instead of drawing a different
two-eye icon.

The shared iOS/terminal accent is **#24DFFF**. iOS backgrounds use **#03090F**,
surfaces **#0A151F**, elevated surfaces **#102331**, and borders **#1A4354**.
Named assistant-message colors retain their canonical semantic values.

## Icon generation prompt

Use case: precise-object-edit. Asset type: production iOS app icon, opaque 1024 x 1024 PNG, square. The attached image is the edit target, the user's exact BZZY single-eye crop. Preserve this cyan/celeste glowing insect eye as faithfully as possible, including its dark inner pupil, tiny bright reflections, fine compound-eye facets, dark top shell and swept antenna. Match the supplied one-eye composition: the inner bridge and left side are intentionally cut by the LEFT edge of the icon, only the right-hand eye is visible; the upward antenna tip remains inside the top edge. Adapt the portrait reference to a square canvas by adding pure black negative space, especially on the right, without changing the eye's shape or angle. Flat pure black background. Keep the full icon square and opaque; iOS applies its own mask, so no rounded rectangle, no drawn icon frame, no shadow outside the artwork. Do not add another eye, text, symbols, a body, decorations, or any new visual elements. Output a clean, high fidelity 1024 by 1024 icon asset.
