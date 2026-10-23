import Foundation
import Accelerate

/// Real microphone frequency energy, not an animated placeholder waveform.
final class VoiceFrequencyAnalyzer: @unchecked Sendable {
    private let size = 1024
    private let setup = vDSP_create_fftsetup(10, FFTRadix(kFFTRadix2))
    private let lock = NSLock()
    private var previous = -Double.infinity
    deinit { if let setup { vDSP_destroy_fftsetup(setup) } }
    func levels(_ samples: [Float], sampleRate: Double, time: Double? = nil) -> [Float]? {
        lock.lock(); defer { lock.unlock() }
        if let time { if time - previous < 1 / 30 { return nil }; previous = time }
        guard let setup, sampleRate.isFinite, sampleRate > 100 else { return Array(repeating: 0, count: 32) }
        var window = [Float](repeating: 0, count: size), input = window
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_NORM))
        for index in 0..<min(size, samples.count) { input[index] = samples[index].isFinite ? samples[index] * window[index] : 0 }
        var real = [Float](repeating: 0, count: size / 2), imaginary = real, powers = real
        real.withUnsafeMutableBufferPointer { r in imaginary.withUnsafeMutableBufferPointer { i in
            var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
            input.withUnsafeBufferPointer { values in values.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: size / 2) {
                vDSP_ctoz($0, 2, &split, 1, vDSP_Length(size / 2))
            } }
            vDSP_fft_zrip(setup, &split, 1, 10, FFTDirection(FFT_FORWARD))
            vDSP_zvmags(&split, 1, &powers, 1, vDSP_Length(size / 2))
        } }
        let maximum = min(12000, sampleRate / 2), minimum = 55.0
        return (0..<32).map { band in
            let lower = minimum * pow(maximum / minimum, Double(band) / 32), upper = minimum * pow(maximum / minimum, Double(band + 1) / 32)
            let first = max(1, min(size / 2 - 1, Int(lower / sampleRate * Double(size))))
            let last = max(first, min(size / 2 - 1, Int(upper / sampleRate * Double(size))))
            let power = powers[first...last].max() ?? 0
            let decibels = 10 * log10(max(1e-12, Double(power) / Double(size * size)))
            return Float(min(1, max(0, (decibels + 65) / 55)))
        }
    }
}
