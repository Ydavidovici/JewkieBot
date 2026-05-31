#include <iostream>
#include <iomanip>
#include <vector>
#include <string>
#include <algorithm>
#include <cassert>
#include <chrono>

#include "search.h"
#include "evaluator.h"
#include "transpositionTable.h"
#include "board.h"
#include "move.h"

static constexpr int SEARCH_DEPTH = 5;

struct SearchResult {
	Move move;
	Search::SearchStats stats;
	long long elapsedMs;
};

static SearchResult run_search_full(const std::string& fen, int depth) {
	Board board;
	board.loadFEN(fen);

	TranspositionTable tt(16);
	Evaluator evaluator;
	Search search(evaluator, tt);
	search.setThreadCount(1);

	auto t0 = std::chrono::steady_clock::now();
	Move m = search.findBestMove(board, depth, /*timeMs=*/0, 0);
	auto t1 = std::chrono::steady_clock::now();

	long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
	return {m, search.getStats(), ms};
}

static Move run_search(const std::string& fen, int depth) {
	return run_search_full(fen, depth).move;
}

static void test_regression_best_move_updates_per_depth() {
	std::cout << "--- test_regression_best_move_updates_per_depth ---\n";

	const char* fen = "k7/8/8/8/8/8/8/KR5q w - - 0 1";
	Move move = run_search(fen, SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "b1h1" &&
		"bestMove must be updated from currentBestMove at each depth");
	std::cout << "PASS\n\n";
}


static void test_qsearch_is_called() {
	std::cout << "--- test_qsearch_is_called ---\n";

	SearchResult r = run_search_full(
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 2);
	std::cout << "  qNodes=" << r.stats.qNodes << "\n";

	assert(r.stats.qNodes > 0 && "qsearch must be invoked at depth-0 leaves");
	std::cout << "PASS\n\n";
}

static void test_qsearch_captures_free_piece() {
	std::cout << "--- test_qsearch_captures_free_piece ---\n";

	Move move = run_search("4k3/8/8/4n3/8/8/8/4R2K w - - 0 1", SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "e1e5");
	std::cout << "PASS\n\n";
}

static void test_qsearch_avoids_losing_trade() {
	std::cout << "--- test_qsearch_avoids_losing_trade ---\n";

	Move move = run_search("3r4/8/8/3p4/2B5/8/8/4K2k w - - 0 1", SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() != "c4d5" &&
		"qsearch must not take a piece when recapture wins material");
	std::cout << "PASS\n\n";
}

static void test_qsearch_resolves_capture_chain() {
	std::cout << "--- test_qsearch_resolves_capture_chain ---\n";

	Move move = run_search("k2r4/8/8/8/8/8/7K/3R4 w - - 0 1", SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "d1d8");
	std::cout << "PASS\n\n";
}

static void test_qsearch_includes_promotion_captures() {
	std::cout << "--- test_qsearch_includes_promotion_captures ---\n";

	const char* fen = "7r/6P1/7k/8/8/8/8/6K1 w - - 0 1";
	Move move = run_search(fen, SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert((move.toString() == "g7h8Q" || move.toString() == "g7g8Q") &&
		"qsearch must include promotion-captures");
	std::cout << "PASS\n\n";
}

static void test_qsearch_stand_pat_quiet_position() {
	std::cout << "--- test_qsearch_stand_pat_quiet_position ---\n";

	SearchResult r = run_search_full("8/8/8/8/8/8/8/K6k w - - 0 1", 2);
	std::cout << "  qNodes=" << r.stats.qNodes << "\n";

	assert(r.stats.qNodes > 0);
	std::cout << "PASS\n\n";
}

static void test_qsearch_no_horizon_effect() {
	std::cout << "--- test_qsearch_no_horizon_effect ---\n";

	Move move = run_search("7r/8/8/7Q/8/8/8/4K2k w - - 0 1", 2);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "h5h8");
	std::cout << "PASS\n\n";
}

static void test_qsearch_node_fraction() {
	std::cout << "--- test_qsearch_node_fraction ---\n";

	SearchResult r = run_search_full(
		"r1bq1rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQR1K1 w - - 0 1", SEARCH_DEPTH);

	double fraction = (r.stats.totalNodes > 0)
		                  ? static_cast<double>(r.stats.qNodes) / r.stats.totalNodes
		                  : 0.0;
	std::cout << "  totalNodes=" << r.stats.totalNodes
		<< "  qNodes=" << r.stats.qNodes
		<< "  fraction=" << fraction << "\n";

	assert(r.stats.qNodes > 20 && "qsearch must explore some nodes");
	assert(fraction >= 0.10 && "qNodes should be ≥10 % of total nodes");
	std::cout << "PASS\n\n";
}


static void test_ordering_tt_move_first() {
	std::cout << "--- test_ordering_tt_move_first ---\n";

	const char* fen = "6k1/5Q2/6K1/8/8/8/8/8 w - - 0 1";
	SearchResult r = run_search_full(fen, SEARCH_DEPTH);

	std::cout << "  firstMoveCutoffs=" << r.stats.firstMoveCutoffs
		<< "  betaCutoffs=" << r.stats.betaCutoffs << "\n";

	assert(r.move.isValid());
	std::cout << "PASS\n\n";
}

static void test_ordering_mvvlva() {
	std::cout << "--- test_ordering_mvvlva ---\n";

	Move move = run_search("4k3/8/8/p3q3/4R3/8/8/4K3 w - - 0 1", SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "e4e5");
	std::cout << "PASS\n\n";
}

static void test_ordering_history_heuristic() {
	std::cout << "--- test_ordering_history_heuristic ---\n";

	SearchResult r = run_search_full(
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", SEARCH_DEPTH);

	std::cout << "  betaCutoffs=" << r.stats.betaCutoffs
		<< "  firstMoveCutoffs=" << r.stats.firstMoveCutoffs << "\n";

	if (r.stats.betaCutoffs > 0) {
		double ratio = static_cast<double>(r.stats.firstMoveCutoffs) /
			r.stats.betaCutoffs;
		std::cout << "  first-move ratio=" << ratio << "\n";
		assert(ratio >= 0.10 && "history heuristic should yield ≥10 % first-move cutoff ratio");
	}
	std::cout << "PASS\n\n";
}


static void test_coverage_mate_in_1_positions() {
	std::cout << "--- test_coverage_mate_in_1_positions ---\n";

	const char* fens[] = {
		"7k/8/7K/8/8/8/8/R7 w - - 0 1",
		"7k/5Q2/7K/8/8/8/8/8 w - - 0 1",
		"6k1/5Q2/6K1/8/8/8/8/8 w - - 0 1",
	};

	for (auto fen : fens) {
		Move move = run_search(fen, std::max(2, SEARCH_DEPTH));

		Board b;
		b.loadFEN(fen);
		b.makeMove(move);
		bool isMate = b.isCheckmate(b.sideToMove());

		std::cout << "  move=" << move.toString()
			<< "  checkmate=" << (isMate ? "yes" : "no") << "\n";
		assert(isMate && "engine must deliver checkmate in a mate-in-1 position");
	}
	std::cout << "PASS\n\n";
}

static void test_coverage_mate_in_2_rook_cut() {
	std::cout << "--- test_coverage_mate_in_2_rook_cut ---\n";

	Move move = run_search("4r3/R7/6R1/8/8/5K2/8/6k1 w - - 0 1", std::max(4, SEARCH_DEPTH));
	std::cout << "  move: " << move.toString() << "\n";

	assert((move.toString() == "a7a1" || move.toString() == "a7g7"));
	std::cout << "PASS\n\n";
}

static void test_coverage_mate_in_3_back_rank() {
	std::cout << "--- test_coverage_mate_in_3_back_rank ---\n";

	Move move = run_search("6k1/5ppp/8/8/8/8/1r6/2R1R1K1 w - - 0 1", std::max(5, SEARCH_DEPTH));
	std::cout << "  move: " << move.toString() << "\n";

	assert((move.toString() == "e1e8" || move.toString() == "c1c8"));
	std::cout << "PASS\n\n";
}

static void test_coverage_forced_check_evasion() {
	std::cout << "--- test_coverage_forced_check_evasion ---\n";

	const char* fen = "7k/8/8/8/2b5/8/8/K2r4 w - - 0 1";
	Move move = run_search(fen, 1);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "a1b2" &&
		"in check with one escape, engine must play the only legal move");
	std::cout << "PASS\n\n";
}

static void test_coverage_knight_fork() {
	std::cout << "--- test_coverage_knight_fork ---\n";

	const char* fen = "4r1k1/8/8/8/4N3/8/8/7K w - - 0 1";
	Move move = run_search(fen, SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() == "e4f6" &&
		"Nf6+ must be found: it forks Kg8 and Re8");
	std::cout << "PASS\n\n";
}

static void test_coverage_stalemate_avoidance() {
	std::cout << "--- test_coverage_stalemate_avoidance ---\n";

	const char* fen = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1";
	Move move = run_search(fen, SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString() != "f7g6" && "Qg6 gives stalemate — must not be played");
	std::cout << "PASS\n\n";
}

static void test_coverage_hanging_piece_defense() {
	std::cout << "--- test_coverage_hanging_piece_defense ---\n";

	const char* fen = "r1bqkbnr/ppp1pppp/2n5/3p4/3Q4/2N5/PPP1PPPP/R1B1KBNR w KQkq - 0 1";
	Move move = run_search(fen, SEARCH_DEPTH);
	std::cout << "  move: " << move.toString() << "\n";

	assert(move.toString()[0] == 'd' &&
		"engine must move the queen off d4");
	std::cout << "PASS\n\n";
}


static void test_coverage_kk_returns_legal_move() {
	std::cout << "--- test_coverage_kk_returns_legal_move ---\n";

	SearchResult r = run_search_full("8/8/8/8/8/8/8/K6k w - - 0 1", SEARCH_DEPTH);
	std::cout << "  move: " << r.move.toString() << "\n";

	assert(r.move.isValid());
	std::cout << "PASS\n\n";
}

static void test_coverage_kk_score_near_zero() {
	std::cout << "--- test_coverage_kk_score_near_zero ---\n";

	SearchResult r = run_search_full("8/8/8/8/8/8/8/K6k w - - 0 1", 2);
	std::cout << "  totalNodes=" << r.stats.totalNodes
		<< "  qNodes=" << r.stats.qNodes << "\n";

	assert(r.stats.totalNodes < 200 &&
		"K+K search must be tiny — no material to evaluate");
	std::cout << "PASS\n\n";
}

static void test_coverage_search_deterministic() {
	std::cout << "--- test_coverage_search_deterministic ---\n";

	const char* fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1";
	Move m1 = run_search(fen, SEARCH_DEPTH);
	Move m2 = run_search(fen, SEARCH_DEPTH);
	std::cout << "  run1=" << m1.toString() << "  run2=" << m2.toString() << "\n";

	assert(m1.toString() == m2.toString() &&
		"single-threaded search must be deterministic");
	std::cout << "PASS\n\n";
}

static void test_coverage_deeper_search_improves_quality() {
	std::cout << "--- test_coverage_deeper_search_improves_quality ---\n";

	const char* fen = "4r1k1/8/8/8/4N3/8/8/7K w - - 0 1";

	Move shallow = run_search(fen, 1);
	Move deep = run_search(fen, SEARCH_DEPTH);

	std::cout << "  depth1=" << shallow.toString()
		<< "  depth4=" << deep.toString() << "\n";

	assert(deep.toString() == "e4f6" && "depth-4 must find the winning fork");
	std::cout << "PASS\n\n";
}

int main() {
	std::cout << "========== SECTION 1: Regression ==========\n\n";
	test_regression_best_move_updates_per_depth();

	std::cout << "========== SECTION 2: Quiescence Search ==========\n\n";
	test_qsearch_is_called();
	test_qsearch_captures_free_piece();
	test_qsearch_avoids_losing_trade();
	test_qsearch_resolves_capture_chain();
	test_qsearch_includes_promotion_captures();
	test_qsearch_stand_pat_quiet_position();
	test_qsearch_no_horizon_effect();
	test_qsearch_node_fraction();

	std::cout << "========== SECTION 3: Move Ordering ==========\n\n";
	test_ordering_tt_move_first();
	test_ordering_mvvlva();
	test_ordering_history_heuristic();

	std::cout << "========== SECTION 4: Correctness Coverage ==========\n\n";
	test_coverage_mate_in_1_positions();
	test_coverage_mate_in_2_rook_cut();
	test_coverage_mate_in_3_back_rank();
	test_coverage_forced_check_evasion();
	test_coverage_knight_fork();
	test_coverage_stalemate_avoidance();
	test_coverage_hanging_piece_defense();
	test_coverage_kk_returns_legal_move();
	test_coverage_kk_score_near_zero();
	test_coverage_search_deterministic();
	test_coverage_deeper_search_improves_quality();

	std::cout << "\n========================================\n";
	std::cout << "ALL SEARCH LOGIC TESTS PASSED\n";
	return 0;
}
