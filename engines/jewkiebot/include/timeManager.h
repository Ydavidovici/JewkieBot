#pragma once
#include <chrono>
#include <cstdint>

class TimeManager {
public:
    static constexpr int DEFAULT_MTG = 40; // Bullet-safety: assume 40 moves left so we don't overspend the early moves and flag.
    static constexpr int HARD_MULT = 3;    // Bullet-safety: cap a single move's hard deadline (was 5 — 5*soft let one move eat ~1/6 of the whole clock).
    static constexpr double MAX_FRACTION = 0.8;
    static constexpr double EXTEND_SCALE = 1.5;
    static constexpr double SHRINK_SCALE = 0.5;
    static constexpr int STABLE_THRESHOLD = 3;
    static constexpr int MOVE_OVERHEAD_MS = 100; // Clock-based play: reserve for engine<->Lichess network lag (was 50 — too small, so cumulative lag flagged us in bullet).
    static constexpr int SAFETY_MS = 50;         // Fixed-movetime play (go movetime / bench / analysis): small margin only — no clock to protect.

    /**
     * Initialize the timer with clock settings.
     * @param millis_left Total remaining time in milliseconds.
     * @param increment   Per-move increment in milliseconds.
     * @param moves_to_go Moves until next time control. <= 0 means unset:
     *                   the manager substitutes DEFAULT_MTG.
     */
    void start(uint64_t millis_left, uint64_t increment, int moves_to_go);

    /**
     * Initialize for a fixed-budget search (UCI 'go movetime N').
     * Soft and hard deadlines both equal movetime minus a small safety
     * margin — there is no division by moves-to-go and no stability scaling.
     */
    void startFixed(uint64_t movetime_ms);

    /**
     * Soft deadline: "don't begin another iteration past this point."
     * Scales with PV stability — see onIterationComplete().
     */
    bool isSoftTimeUp() const;

    /**
     * Hard deadline: "abort the current iteration immediately."
     * Capped at MAX_FRACTION of the remaining clock so we never flag.
     */
    bool isHardTimeUp() const;

    /**
     * Search calls this after each completed iterative-deepening depth.
     * Stable best move (>= STABLE_THRESHOLD repeats) shrinks the soft
     * deadline; a changed best move extends it (still capped by hard).
     */
    void onIterationComplete(bool best_move_changed);

    void startInfinite();

    std::chrono::steady_clock::time_point getStartTime() const { return start_time_; }

    // Base (pre-stability-scale) allocations, exposed for testing the allocator
    // directly without sleeping on the wall clock.
    int64_t getSoftAllocMs() const { return soft_alloc_.count(); }
    int64_t getHardAllocMs() const { return hard_alloc_.count(); }

private:
    std::chrono::steady_clock::time_point start_time_{};
    std::chrono::milliseconds soft_alloc_{0};
    std::chrono::milliseconds hard_alloc_{0};
    double soft_scale_{1.0};
    int stable_count_{0};
    bool is_infinite_{false};
};
