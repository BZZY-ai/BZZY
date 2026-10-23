import Foundation
import Accelerate

/// Real microphone frequency energy, not an animated placeholder waveform.
final class VoiceFrequencyAnalyzer: @unchecked Sendable {
    static let bandCount = 64
    private let size = 2048
    private let setup = vDSP_create_fftsetup(11, FFTRadix(kFFTRadix2))
    private let lock = NSLock()
    private var previous = -Double.infinity
    private var recent: [Float] = []
    private var previousRate: Double?
    deinit { if let setup { vDSP_destroy_fftsetup(setup) } }
    func levels(_ samples: [Float], sampleRate: Double, time: Double? = nil) -> [Float]? {
        lock.lock(); defer { lock.unlock() }
        guard let setup, sampleRate.isFinite, sampleRate > 100 else { return Array(repeating: 0, count: Self.bandCount) }
        if previousRate != sampleRate { recent = []; previousRate = sampleRate }
        recent.append(contentsOf: samples.suffix(size).map { $0.isFinite ? $0 : 0 })
        if recent.count > size { recent.removeFirst(recent.count - size) }
        if let time { if time - previous < 1 / 60 { return nil }; previous = time }
        var window = [Float](repeating: 0, count: size), input = window
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_NORM))
        let start = size - recent.count
        for index in recent.indices { input[start + index] = recent[index] * window[start + index] }
        var real = [Float](repeating: 0, count: size / 2), imaginary = real, powers = real
        real.withUnsafeMutableBufferPointer { r in imaginary.withUnsafeMutableBufferPointer { i in
            var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
            input.withUnsafeBufferPointer { values in values.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: size / 2) {
                vDSP_ctoz($0, 2, &split, 1, vDSP_Length(size / 2))
            } }
            vDSP_fft_zrip(setup, &split, 1, 11, FFTDirection(FFT_FORWARD))
            vDSP_zvmags(&split, 1, &powers, 1, vDSP_Length(size / 2))
        } }
        let maximum = min(12000, sampleRate / 2), minimum = 55.0
        return (0..<Self.bandCount).map { band in
            let lower = minimum * pow(maximum / minimum, Double(band) / Double(Self.bandCount)), upper = minimum * pow(maximum / minimum, Double(band + 1) / Double(Self.bandCount))
            let first = max(1, min(size / 2 - 1, Int(lower / sampleRate * Double(size))))
            let last = max(first, min(size / 2 - 1, Int(upper / sampleRate * Double(size))))
            let power = powers[first...last].max() ?? 0
            let decibels = 10 * log10(max(1e-12, Double(power) / Double(size * size)))
            return Float(min(1, max(0, (decibels + 65) / 55)))
        }
    }
}

/// Fast attack and a gentle release at display cadence keep real FFT samples
/// fluid between audio callbacks. Silence converges to an exact flat line.
struct VoiceSpectrumSmoother {
    private(set) var levels = [Float](repeating: 0, count: VoiceFrequencyAnalyzer.bandCount)
    private var previous: Double?
    mutating func advance(toward target: [Float], time: Double) {
        guard time.isFinite else { return }
        let elapsed = previous.map { time - $0 } ?? 1 / 60
        previous = time
        guard elapsed > 0 else { return }
        let dt = min(0.05, elapsed)
        for index in levels.indices {
            let value = index < target.count && target[index].isFinite ? min(1, max(0, target[index])) : 0
            let alpha = Float(1 - exp(-dt / (value > levels[index] ? 0.035 : 0.12)))
            levels[index] += (value - levels[index]) * alpha
            if levels[index] < 0.001 { levels[index] = 0 }
        }
    }
    mutating func reset() { self = Self() }
}
