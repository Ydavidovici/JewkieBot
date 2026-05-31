#include "timeManager.h"
#include <algorithm>

void TimeManager::start(uint64_t millis_left, uint64_t inc, int mtg) {
    const int mtg_eff = (mtg <= 0) ? DEFAULT_MTG : mtg;

    const int64_t remaining =
        (millis_left > static_cast<uint64_t>(SAFETY_MS))
            ? static_cast<int64_t>(millis_left) - SAFETY_MS
            : 0;

    const int64_t max_alloc =
        static_cast<int64_t>(remaining * MAX_FRACTION) + static_cast<int64_t>(inc);

    const int64_t raw_soft = remaining / mtg_eff + static_cast<int64_t>(inc);

    const int64_t soft = std::min(raw_soft, max_alloc);
    const int64_t hard = std::min<int64_t>(soft * HARD_MULT, max_alloc);

    start_time_ = std::chrono::steady_clock::now();
    soft_alloc_ = std::chrono::milliseconds(soft);
    hard_alloc_ = std::chrono::milliseconds(hard);
    soft_scale_ = 1.0;
    stable_count_ = 0;
}

void TimeManager::startFixed(uint64_t movetime_ms) {
    const int64_t budget =
        (movetime_ms > static_cast<uint64_t>(SAFETY_MS))
            ? static_cast<int64_t>(movetime_ms) - SAFETY_MS
            : 0;

    start_time_ = std::chrono::steady_clock::now();
    soft_alloc_ = std::chrono::milliseconds(budget);
    hard_alloc_ = std::chrono::milliseconds(budget);
    soft_scale_ = 1.0;
    stable_count_ = 0;
}

bool TimeManager::isSoftTimeUp() const {
    const auto scaled = std::chrono::milliseconds(
        static_cast<int64_t>(soft_alloc_.count() * soft_scale_));
    const auto effective = std::min(scaled, hard_alloc_);
    return std::chrono::steady_clock::now() >= start_time_ + effective;
}

bool TimeManager::isHardTimeUp() const {
    return std::chrono::steady_clock::now() >= start_time_ + hard_alloc_;
}

void TimeManager::onIterationComplete(bool best_move_changed) {
    if (best_move_changed) {
        stable_count_ = 0;
        soft_scale_ = EXTEND_SCALE;
    } else {
        ++stable_count_;
        if (stable_count_ >= STABLE_THRESHOLD) {
            soft_scale_ = SHRINK_SCALE;
        } else {
            soft_scale_ = 1.0;
        }
    }
}
