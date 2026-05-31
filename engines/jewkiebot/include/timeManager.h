#pragma once
#include <chrono>
#include <cstdint>

class TimeManager {
public:
    static constexpr int DEFAULT_MTG = 30;
    static constexpr int HARD_MULT = 5;
    static constexpr double MAX_FRACTION = 0.8;
    static constexpr double EXTEND_SCALE = 1.5;
    static constexpr double SHRINK_SCALE = 0.5;
    static constexpr int STABLE_THRESHOLD = 3;
    static constexpr int SAFETY_MS = 50;

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

private:
    std::chrono::steady_clock::time_point start_time_{};
    std::chrono::milliseconds soft_alloc_{0};
    std::chrono::milliseconds hard_alloc_{0};
    double soft_scale_{1.0};
    int stable_count_{0};
};
