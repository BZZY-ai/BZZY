#include <metal_stdlib>
using namespace metal;

// Continuous source sampling preserves the supplied texture. The eyes remain
// fully open: this shader never adds eyelids, blinks, or replacement pupils.
[[ stitchable ]] float2 bzzyFlyMotion(float2 position, float2 size, float2 gaze, float time, float energy) {
    float2 pixel = position / max(size, float2(1.0)) * float2(586.0, 293.0);
    float onset = smoothstep(0.0, 1.2, time);
    float breath = 1.0 + 0.005 * sin(time * 1.15) * onset * energy;
    float2 source = (pixel - float2(293.0, 165.0)) / breath + float2(293.0, 165.0);
    for (int eye = 0; eye < 2; eye++) {
        float side = eye == 0 ? -1.0 : 1.0;
        float2 center = float2(eye == 0 ? 199.0 : 386.0, 179.0);
        float2 pupil = float2(eye == 0 ? 218.0 : 365.0, 202.0);
        float outline = length((pixel - center) / float2(76.0, 86.0));
        float body = 1.0 - smoothstep(0.88, 1.24, outline);
        float2 shift = float2(gaze.x * 1.4, gaze.y * 0.9 + sin(time * 1.1 + side * 0.45) * 0.65 * onset * energy);
        float pupilMask = (1.0 - smoothstep(0.48, 1.0, length((pixel - pupil) / float2(57.0, 74.0))))
            * (1.0 - smoothstep(0.67, 1.0, outline));
        source -= shift * body + float2(gaze.x * 8.0, gaze.y * 6.0) * pupilMask;
        float stemX = 293.0 + side * (165.0 - pixel.y) * 1.2;
        float stem = (1.0 - smoothstep(20.0, 48.0, abs(pixel.x - stemX)))
            * (1.0 - smoothstep(112.0, 165.0, pixel.y));
        source -= float2(sin(time * 1.4 + side * 0.55) * 2.0, sin(time * 1.12 + side) * 2.8) * stem * onset * energy;
    }
    return source / float2(586.0, 293.0) * size;
}
