# BZZY artwork and celeste theme

The current iOS presentation uses the CLI's compact terminal layout. In-app
mascot views are hidden by `BZZYTheme.showsMascot = false`, with no reserved hero
spacing. The artwork and animation below remain intact for restoration through
that one appearance flag. User transcript rails use **#58DFC7** on **#0B302E**;
assistant rails use **#B9B6FF** on **#101B2C**. Controls and panels use restrained
4-point corners, separators and monospaced labels with accessible touch targets.

`BZZY/Assets.xcassets/BZZYEyes.imageset/eyes.png` is the supplied two-eye PNG,
copied without redrawing, cropping or resampling. The iOS view scales it as a
complete mark and uses screen blending to integrate its black background with
the app surface. The original asset remains byte-identical to the supplied PNG.
The view displays it 25% larger, clipping only unused black side margins.
`FlyMotion.metal` gently distorts the original pixels for pupil tracking, antenna
sway and breathing; it never replaces the compound-eye texture or draws eyelids.
There is no blinking or eye-closing state. Touch targets ease with a speed limit;
idle gaze now uses rapid darts of roughly 100–200 ms, separated by varied
half-second-to-one-second holds while checking nearby directions. Touch tracking
keeps its separate slower easing rather than inheriting the idle dart speed;
the animation clock pauses offscreen/background and ignores long frame gaps.
Reduce Motion disables the distortion and returns to the original still image.
The Xcode Metal toolchain compiles the shader; native macOS previews compile and
load the same source into their own Metal library.

The opaque 1024×1024 `AppIcon.appiconset/AppIcon.png` is a complete single-eye
and antenna emblem, centered on black with balanced negative space and no cut
off head fragments. It preserves the mascot's cyan compound-eye texture and
highlight. iOS applies the icon mask. The built-in imagegen tool prepared the
bitmap, followed by standard resizing. The native preview copies this actual
icon. See [build 13's final asset and generation prompt](app-icon-artwork.md).

The shared iOS/terminal accent is **#24DFFF**. iOS backgrounds use **#03090F**,
surfaces **#0A151F**, elevated surfaces **#102331**, and borders **#1A4354**.
Named assistant-message colors retain their canonical semantic values.

## Earlier icon

Builds through 12 used a literal single-eye half-face crop. Build 13 replaces
that composition with the complete emblem described above; the in-app two-eye
mascot remains the original supplied artwork.
