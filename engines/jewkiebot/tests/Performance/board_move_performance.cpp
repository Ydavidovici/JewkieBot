#include "board.h"
#include "move.h"
#include "types.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>
#include <ctime>       // For timestamp
#include <iomanip>     // For timestamp formatting
#include <sstream>     // For filename construction
#include <filesystem>  // For pathing and directory creation

using Clock = std::chrono::steady_clock;
using ns = std::chrono::nanoseconds;
namespace fs = std::filesystem;

struct BenchPos {
	const char* name;
	const char* fen;
};

static const BenchPos POSITIONS[] = {
	{"startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
	{"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"},
	{"position_3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"},
	{"position_4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1"},
	{"position_5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8"},
	{"position_6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10"},
};

static double elapsed_ms(Clock::time_point t0) {
	return std::chrono::duration_cast<ns>(Clock::now() - t0).count() / 1e6;
}

struct Stat {
	double min_ms = 1e18, max_ms = 0, sum = 0, sum_sq = 0;
	int n = 0;

	void add(double ms) {
		min_ms = std::min(min_ms, ms);
		max_ms = std::max(max_ms, ms);
		sum += ms;
		sum_sq += ms * ms;
		++n;
	}

	double mean() const { return n ? sum / n : 0.0; }

	double stddev() const {
		if (n < 2) return 0.0;
		double m = mean();
		return std::sqrt(std::max(0.0, sum_sq / n - m * m));
	}
};

static uint64_t perft(Board& b, int depth) {
	if (depth == 0) return 1;
	auto moves = b.generateLegalMoves();
	if (depth == 1) return moves.size();
	uint64_t total = 0;
	for (const Move& m : moves) {
		if (!b.makeMove(m)) continue;
		total += perft(b, depth - 1);
		b.unmakeMove();
	}
	return total;
}

static void bench_perft() {
	std::cout << "\n========== PERFT THROUGHPUT ==========\n";
	std::printf("  %-14s %-6s  %14s   %10s   %8s\n",
	            "position", "depth", "nodes", "ms", "MNps");
	std::cout << "  " << std::string(64, '-') << "\n";

	struct Job {
		const char* name;
		const char* fen;
		int depth;
	};
	const Job jobs[] = {
		{"startpos", POSITIONS[0].fen, 5},
		{"startpos", POSITIONS[0].fen, 6},
		{"kiwipete", POSITIONS[1].fen, 4},
		{"kiwipete", POSITIONS[1].fen, 5},
		{"position_3", POSITIONS[2].fen, 5},
		{"position_4", POSITIONS[3].fen, 4},
		{"position_5", POSITIONS[4].fen, 4},
		{"position_6", POSITIONS[5].fen, 4},
	};

	for (const auto& j : jobs) {
		Board b;
		b.loadFEN(j.fen);
		auto t0 = Clock::now();
		uint64_t n = perft(b, j.depth);
		double ms = elapsed_ms(t0);
		double mnps = ms > 0 ? (n / ms / 1000.0) : 0.0;
		std::printf("  %-14s d=%d   %14llu   %10.1f   %8.2f\n",
		            j.name, j.depth, (unsigned long long)n, ms, mnps);
	}
}

static void bench_movegen() {
	std::cout << "\n========== MOVE GENERATION THROUGHPUT ==========\n";
	std::printf("  %-14s   %10s   %10s   %12s\n",
	            "position", "moves/call", "ns/call", "calls/sec");
	std::cout << "  " << std::string(56, '-') << "\n";

	constexpr int WARMUP = 2000;
	constexpr int ITERS = 200000;
	for (const auto& p : POSITIONS) {
		Board b;
		b.loadFEN(p.fen);
		for (int i = 0; i < WARMUP; ++i) {
			auto v = b.generateLegalMoves();
			(void)v;
		}
		size_t moves_total = 0;
		auto t0 = Clock::now();
		for (int i = 0; i < ITERS; ++i) {
			auto v = b.generateLegalMoves();
			moves_total += v.size();
		}
		double ms = elapsed_ms(t0);
		double ns_per = (ms * 1e6) / ITERS;
		double per_s = ITERS / (ms / 1000.0);
		double avg = (double)moves_total / ITERS;
		std::printf("  %-14s   %10.1f   %10.0f   %12.0f\n",
		            p.name, avg, ns_per, per_s);
	}
}

static void bench_make_unmake() {
	std::cout << "\n========== MAKE/UNMAKE THROUGHPUT ==========\n";
	std::printf("  %-14s   %10s   %12s\n", "position", "ns/pair", "pairs/sec");
	std::cout << "  " << std::string(46, '-') << "\n";

	constexpr int ITERS = 200000;
	for (const auto& p : POSITIONS) {
		Board b;
		b.loadFEN(p.fen);
		auto moves = b.generateLegalMoves();
		if (moves.empty()) continue;
		auto t0 = Clock::now();
		for (int i = 0; i < ITERS; ++i) {
			const Move& m = moves[i % moves.size()];
			if (b.makeMove(m)) b.unmakeMove();
		}
		double ms = elapsed_ms(t0);
		std::printf("  %-14s   %10.0f   %12.0f\n",
		            p.name,
		            (ms * 1e6) / ITERS,
		            ITERS / (ms / 1000.0));
	}
}

static void bench_zobrist_recompute() {
	std::cout << "\n========== ZOBRIST RECOMPUTE ==========\n";
	std::printf("  %-14s   %10s   %12s\n", "position", "ns/call", "calls/sec");
	std::cout << "  " << std::string(46, '-') << "\n";

	constexpr int ITERS = 500000;
	uint64_t sink = 0;
	for (const auto& p : POSITIONS) {
		Board b;
		b.loadFEN(p.fen);
		auto t0 = Clock::now();
		for (int i = 0; i < ITERS; ++i) sink ^= b.zobristKey();
		double ms = elapsed_ms(t0);
		std::printf("  %-14s   %10.0f   %12.0f\n",
		            p.name,
		            (ms * 1e6) / ITERS,
		            ITERS / (ms / 1000.0));
	}
	if (sink == 0xDEADBEEFCAFEBABEULL) std::cout << "(impossible)\n";
}

static void bench_fen_io() {
	std::cout << "\n========== FEN PARSE / EMIT ==========\n";
	std::printf("  %-14s   %14s   %14s\n", "position", "loadFEN ns", "toFEN ns");
	std::cout << "  " << std::string(50, '-') << "\n";

	constexpr int ITERS = 50000;
	size_t sink = 0;
	for (const auto& p : POSITIONS) {
		Board b;
		auto t0 = Clock::now();
		for (int i = 0; i < ITERS; ++i) b.loadFEN(p.fen);
		double load_ms = elapsed_ms(t0);

		b.loadFEN(p.fen);
		t0 = Clock::now();
		for (int i = 0; i < ITERS; ++i) sink += b.toFEN().size();
		double emit_ms = elapsed_ms(t0);

		std::printf("  %-14s   %14.0f   %14.0f\n",
		            p.name,
		            (load_ms * 1e6) / ITERS,
		            (emit_ms * 1e6) / ITERS);
	}
	if (sink == 0xDEADBEEFULL) std::cout << "(impossible)\n";
}

static void bench_variance() {
	std::cout << "\n========== VARIANCE (kiwipete d4 x 5 runs) ==========\n";
	Stat s;
	for (int r = 0; r < 5; ++r) {
		Board b;
		b.loadFEN(POSITIONS[1].fen);
		auto t0 = Clock::now();
		uint64_t n = perft(b, 4);
		double ms = elapsed_ms(t0);
		s.add(ms);
		std::printf("  run %d: %llu nodes in %.1f ms  (%.2f MNps)\n",
		            r + 1, (unsigned long long)n, ms, n / ms / 1000.0);
	}
	std::printf("  mean=%.1f ms  min=%.1f  max=%.1f  stddev=%.2f  (cv=%.1f%%)\n",
	            s.mean(), s.min_ms, s.max_ms, s.stddev(),
	            s.mean() > 0 ? 100.0 * s.stddev() / s.mean() : 0.0);
}

int main(int argc, char** argv) {
	bool do_perft = true, do_movegen = true, do_make_unmake = true,
	     do_zobrist = true, do_fen = true, do_variance = true;

	for (int i = 1; i < argc; ++i) {
		std::string a = argv[i];
		if (a == "--only-perft") { do_movegen = do_make_unmake = do_zobrist = do_fen = do_variance = false; }
		else if (a == "--no-perft") { do_perft = false; }
		else if (a == "--no-variance") { do_variance = false; }
		else if (a == "--quick") { do_fen = do_variance = false; }
	}

    // --- Format the current time for the filename ---
    auto now = std::chrono::system_clock::now();
    std::time_t now_time = std::chrono::system_clock::to_time_t(now);
    std::tm* local_tm = std::localtime(&now_time);

    std::ostringstream filename_oss;
    filename_oss << "board_move_performance_";
    filename_oss << std::put_time(local_tm, "%Y%m%d_%H%M%S");
    filename_oss << ".txt";

    // --- Determine Output Directory ---
    fs::path current_dir = fs::current_path();
    fs::path out_dir;

    // Check if the program is being run from inside the CLion/CMake "build" directory
    std::string cur_dir_name = current_dir.filename().string();
    if (cur_dir_name == "build" || cur_dir_name.find("cmake-build") != std::string::npos) {
        // Go up one level to the project root, then into tests/Performance/results
        out_dir = current_dir.parent_path() / "tests" / "Performance" / "results";
    } else {
        // Fallback: assume we are already at the project root
        out_dir = current_dir / "tests" / "Performance" / "results";
    }

    // Ensure the output directory actually exists (creates it if it doesn't)
    fs::create_directories(out_dir);

    // Construct the final full file path
    fs::path full_path = out_dir / filename_oss.str();

    // --- Notify user via standard error (shows up in IDE console) ---
    std::cerr << "Running benchmarks...\n";
    std::cerr << "Output is being redirected to: " << full_path.string() << "\n";

    // --- Redirect stdout to the dynamically named file ---
    // Note: We use .string().c_str() because freopen expects a C-style string
    if (std::freopen(full_path.string().c_str(), "w", stdout) == nullptr) {
        std::cerr << "Error: Could not open output file: " << full_path.string() << "\n";
        return 1;
    }

	std::cout << "Board class performance benchmarks\n";

	if (do_perft) bench_perft();
	if (do_movegen) bench_movegen();
	if (do_make_unmake) bench_make_unmake();
	if (do_zobrist) bench_zobrist_recompute();
	if (do_fen) bench_fen_io();
	if (do_variance) bench_variance();

	std::cout << "\nDone.\n";

    // Close the file explicitly
    std::fclose(stdout);
    std::cerr << "Done. Benchmark saved successfully.\n";

	return 0;
}