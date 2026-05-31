#include "search.h"
#include "evaluator.h"
#include "transpositionTable.h"
#include "board.h"
#include "move.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

struct Pos {
	const char* label;
	const char* fen;
};

static const Pos POSITIONS[] = {
	{"Startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
	{"Italian", "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1"},
	{"Kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"},
	{"Middlegame", "r1bq1rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQR1K1 w - - 0 1"},
	{"Endgame", "8/5k2/3p4/1p1Pp2p/pP2Pp1P/P4P2/8/1K6 w - - 0 1"},
	{"Tactical", "4r1k1/8/8/8/4N3/8/8/7K w - - 0 1"},
};
static constexpr int N_POSITIONS = sizeof(POSITIONS) / sizeof(POSITIONS[0]);

static constexpr int SEARCH_DEPTH = 10;

struct Result {
	Move move;
	Search::SearchStats stats;
	double ms;
};

static Result run(const char* fen, int depth, int timeLimitMs = 0) {
	Board board;
	board.loadFEN(fen);
	TranspositionTable tt(16);
	Evaluator ev;
	Search search(ev, tt);
	search.setThreadCount(1);

	auto t0 = Clock::now();
	Move m = search.findBestMove(board, depth, timeLimitMs, 0);
	double ms = std::chrono::duration_cast<std::chrono::microseconds>(
		Clock::now() - t0).count() / 1000.0;
	return {m, search.getStats(), ms};
}

static long long nps(long long nodes, double ms) {
	return ms > 0 ? (long long)(nodes * 1000.0 / ms) : nodes * 1000LL;
}

static double pct(long long num, long long den) {
	return den > 0 ? 100.0 * num / den : 0.0;
}

static const char* warn(bool bad) { return bad ? "  <<" : ""; }

static void bench_nps() {
	std::printf("\n========== 1. NPS BENCHMARK (Startpos, depths 1-%d) ==========\n", SEARCH_DEPTH + 1);
	std::printf("  %-6s  %-12s  %-12s  %-8s  %-14s\n", "Depth", "Nodes", "QNodes", "ms", "NPS");
	std::printf("  %s\n", std::string(58, '-').c_str());

	for (int d = 1; d <= SEARCH_DEPTH + 1; ++d) {
		Result r = run(POSITIONS[0].fen, d);
		std::printf("  %-6d  %-12lld  %-12lld  %-8.1f  %-14lld\n",
		            d, r.stats.totalNodes, r.stats.qNodes, r.ms,
		            nps(r.stats.totalNodes, r.ms));
	}
	std::printf("\n  (Higher NPS = faster engine. Compare before/after any eval or movegen change.)\n");
}

static void bench_node_scaling() {
	std::printf("\n========== 2. NODE SCALING (depths 1-%d, all positions) ==========\n", SEARCH_DEPTH);
	std::printf("  INVARIANT: totalNodes(d) > totalNodes(d-1) for every position.\n\n");

	int failures = 0;

	for (int p = 0; p < N_POSITIONS; ++p) {
		const Pos& pos = POSITIONS[p];
		std::printf("  [%s]\n", pos.label);
		std::printf("  %-6s  %-12s  %-12s  %-8s\n", "Depth", "Nodes", "QNodes", "ms");
		std::printf("  %s\n", std::string(42, '-').c_str());

		long long prev = 0;
		for (int d = 1; d <= SEARCH_DEPTH; ++d) {
			Result r = run(pos.fen, d);
			bool bad = (d > 1 && r.stats.totalNodes <= prev);
			std::printf("  %-6d  %-12lld  %-12lld  %-8.1f%s\n",
			            d, r.stats.totalNodes, r.stats.qNodes, r.ms,
			            bad ? "  << INVARIANT VIOLATED: nodes did not increase" : "");
			if (bad) ++failures;
			prev = r.stats.totalNodes;
		}
		std::printf("\n");
	}

	if (failures == 0)
		std::printf("  Node monotonicity: OK across all positions.\n");
	else
		std::printf("  Node monotonicity: %d VIOLATION(S) — search may be terminating early or miscounting.\n",
		            failures);
}

static void bench_ebf() {
	std::printf("\n========== 3. EFFECTIVE BRANCHING FACTOR ==========\n");
	std::printf("  EBF = N(d) / N(d-1). Ideal alpha-beta: ~4-6. >15 suggests broken pruning.\n\n");

	for (int p = 0; p < N_POSITIONS; ++p) {
		const Pos& pos = POSITIONS[p];
		std::printf("  [%s]\n", pos.label);
		std::printf("  %-14s  %-12s  %-12s  %-8s\n", "Transition", "N(d-1)", "N(d)", "EBF");
		std::printf("  %s\n", std::string(52, '-').c_str());

		long long nodes[SEARCH_DEPTH + 2] = {};
		for (int d = 1; d <= SEARCH_DEPTH + 1; ++d)
			nodes[d] = run(pos.fen, d).stats.totalNodes;

		double maxEBF = 0.0;
		for (int d = 2; d <= SEARCH_DEPTH + 1; ++d) {
			double ebf = nodes[d - 1] > 0
				             ? (double)nodes[d] / nodes[d - 1]
				             : 0.0;
			if (ebf > maxEBF) maxEBF = ebf;
			std::string tr = std::to_string(d - 1) + " -> " + std::to_string(d);
			std::printf("  %-14s  %-12lld  %-12lld  %.2f%s\n",
			            tr.c_str(), nodes[d - 1], nodes[d], ebf,
			            warn(ebf > 15.0));
		}
		std::printf("  Max EBF: %.2f%s\n\n", maxEBF,
		            maxEBF > 15.0 ? "  << HIGH — pruning or move ordering may be broken" : "");
	}
}

static void bench_tt_hit_rate() {
	std::printf("\n========== 4. TRANSPOSITION TABLE HIT RATE ==========\n");
	std::printf("  ttProbes%%  = any TT entry found (used for move ordering).\n");
	std::printf("  ttScore%%   = entry found AND depth sufficient for score cutoff.\n");
	std::printf("  Both are measured against non-Q nodes (totalNodes - qNodes).\n\n");

	std::printf("  %-12s  %-5s  %-12s  %-10s  %-10s  %-10s\n",
	            "Position", "D", "non-Q Nodes", "ttProbes%", "ttScore%", "ttScore/ttProbes");
	std::printf("  %s\n", std::string(68, '-').c_str());

	for (int p = 0; p < N_POSITIONS; ++p) {
		const Pos& pos = POSITIONS[p];
		for (int d = std::max(1, SEARCH_DEPTH - 2); d <= SEARCH_DEPTH; ++d) {
			Result r = run(pos.fen, d);
			long long nonQ = r.stats.totalNodes - r.stats.qNodes;
			double probesPct = pct(r.stats.ttProbes, nonQ);
			double scorePct  = pct(r.stats.ttHits,   nonQ);
			double ratio     = r.stats.ttProbes > 0
			                   ? pct(r.stats.ttHits, r.stats.ttProbes)
			                   : 0.0;
			std::printf("  %-12s  %-5d  %-12lld  %7.1f%%   %7.1f%%   %7.1f%%%s\n",
			            pos.label, d, nonQ, probesPct, scorePct, ratio,
			            warn(d >= 4 && probesPct < 10.0));
		}
		std::printf("\n");
	}

	std::printf("  (<< at depth 4+: ttProbes%% < 10%% — few transpositions or TT not being probed.)\n");
	std::printf("  (Low ttScore%%/ttProbes ratio means IID depth mismatch is the limiting factor.)\n");
}

static void bench_move_ordering() {
	std::printf("\n========== 5. MOVE ORDERING EFFICIENCY ==========\n");
	std::printf("  FM%% = firstMoveCutoffs / betaCutoffs * 100 (higher = better ordering).\n");
	std::printf("  Beta%% = betaCutoffs / totalNodes * 100 (higher = more pruning).\n");
	std::printf("  INVARIANT: firstMoveCutoffs <= betaCutoffs.\n\n");

	std::printf("  %-12s  %-5s  %-12s  %-12s  %-12s  %-7s  %-7s\n",
	            "Position", "D", "Nodes", "BetaCuts", "FMCuts", "FM%", "Beta%");
	std::printf("  %s\n", std::string(72, '-').c_str());

	int invariantViolations = 0;

	for (int p = 0; p < N_POSITIONS; ++p) {
		const Pos& pos = POSITIONS[p];
		for (int d = std::max(1, SEARCH_DEPTH - 2); d <= SEARCH_DEPTH; ++d) {
			Result r = run(pos.fen, d);
			bool inv = r.stats.firstMoveCutoffs > r.stats.betaCutoffs;
			if (inv) ++invariantViolations;
			double fm = pct(r.stats.firstMoveCutoffs, r.stats.betaCutoffs);
			double beta = pct(r.stats.betaCutoffs, r.stats.totalNodes);
			std::printf("  %-12s  %-5d  %-12lld  %-12lld  %-12lld  %5.1f%%  %5.1f%%%s\n",
			            pos.label, d,
			            r.stats.totalNodes, r.stats.betaCutoffs,
			            r.stats.firstMoveCutoffs, fm, beta,
			            inv ? "  << INVARIANT VIOLATED" : warn(d >= 4 && fm < 30.0));
		}
		std::printf("\n");
	}

	if (invariantViolations > 0)
		std::printf("  INVARIANT VIOLATED %d time(s): firstMoveCutoffs > betaCutoffs — stat tracking bug.\n",
		            invariantViolations);
	else
		std::printf("  Invariant (FM <= beta cutoffs): OK.\n");

	std::printf("  (<< at depth 4+: FM%% < 30%% — TT move, captures, or history may not be ordering correctly.)\n");
}

static void bench_qsearch_fraction() {
	std::printf("\n========== 6. QUIESCENCE SEARCH FRACTION ==========\n");
	std::printf("  Q%% = qNodes / totalNodes * 100. In tactical positions at d4+, <10%% is low.\n");
	std::printf("  INVARIANT: qNodes <= totalNodes.\n\n");

	std::printf("  %-12s  %-5s  %-12s  %-12s  %-8s\n",
	            "Position", "D", "Nodes", "QNodes", "Q%");
	std::printf("  %s\n", std::string(56, '-').c_str());

	int invariantViolations = 0;

	for (int p = 0; p < N_POSITIONS; ++p) {
		const Pos& pos = POSITIONS[p];
		for (int d = std::max(1, SEARCH_DEPTH - 2); d <= SEARCH_DEPTH; ++d) {
			Result r = run(pos.fen, d);
			bool inv = r.stats.qNodes > r.stats.totalNodes;
			if (inv) ++invariantViolations;
			double q = pct(r.stats.qNodes, r.stats.totalNodes);
			std::printf("  %-12s  %-5d  %-12lld  %-12lld  %5.1f%%%s\n",
			            pos.label, d, r.stats.totalNodes, r.stats.qNodes, q,
			            inv ? "  << INVARIANT VIOLATED" : warn(d >= 4 && q < 10.0));
		}
		std::printf("\n");
	}

	if (invariantViolations > 0)
		std::printf("  INVARIANT VIOLATED %d time(s): qNodes > totalNodes — node counting bug.\n",
		            invariantViolations);
	else
		std::printf("  Invariant (qNodes <= totalNodes): OK.\n");

	std::printf("  (<< at depth 4+: Q%% < 10%% in non-quiet positions — qsearch may not be engaging.)\n");
}

static void bench_warm_tt() {
	std::printf("\n========== 7. WARM vs COLD TT (Italian, depth %d) ==========\n", SEARCH_DEPTH);
	std::printf("  INVARIANT: warm TT hits >= cold TT hits.\n\n");

	const char* fen = POSITIONS[1].fen;

	Board b1;
	b1.loadFEN(fen);
	TranspositionTable sharedTT(16);
	Evaluator ev;

	Search s1(ev, sharedTT);
	s1.setThreadCount(1);
	auto t0 = Clock::now();
	s1.findBestMove(b1, SEARCH_DEPTH, 0, 0);
	double ms1 = std::chrono::duration_cast<std::chrono::microseconds>(
		Clock::now() - t0).count() / 1000.0;
	auto st1 = s1.getStats();

	Board b2;
	b2.loadFEN(fen);
	Search s2(ev, sharedTT);
	s2.setThreadCount(1);
	t0 = Clock::now();
	s2.findBestMove(b2, SEARCH_DEPTH, 0, 0);
	double ms2 = std::chrono::duration_cast<std::chrono::microseconds>(
		Clock::now() - t0).count() / 1000.0;
	auto st2 = s2.getStats();

	auto printRow = [](const char* label, const Search::SearchStats& st, double ms) {
		long long nonQ = st.totalNodes - st.qNodes;
		double probesPct = pct(st.ttProbes, nonQ);
		double scorePct  = pct(st.ttHits,   nonQ);
		std::printf("  %-8s  %-12lld  %-12lld  %6.1f%%  %6.1f%%  %8.1f ms\n",
		            label, st.totalNodes, st.ttProbes, probesPct, scorePct, ms);
	};

	std::printf("  %-8s  %-12s  %-12s  %-8s  %-8s  %-10s\n",
	            "Run", "Nodes", "ttProbes", "Probe%", "Score%", "Elapsed");
	std::printf("  %s\n", std::string(62, '-').c_str());
	printRow("Cold", st1, ms1);
	printRow("Warm", st2, ms2);

	bool inv = st2.ttHits >= st1.ttHits;
	std::printf("\n  Score hits %s (cold=%lld, warm=%lld).%s\n",
	            inv ? "increased or stayed equal" : "DECREASED",
	            st1.ttHits, st2.ttHits,
	            inv ? "" : "  << INVARIANT VIOLATED — TT replacement may be discarding useful entries.");
}

static void bench_time_control() {
	std::printf("\n========== 8. TIME CONTROL COMPLIANCE ==========\n");
	std::printf("  Engine must return a valid move within 5x the time budget.\n\n");

	struct Job {
		const char* label;
		const char* fen;
		int budgetMs;
	};
	const Job jobs[] = {
		{"Startpos 500ms", POSITIONS[0].fen, 500},
		{"Italian 1000ms", POSITIONS[1].fen, 1000},
		{"Kiwipete 500ms", POSITIONS[2].fen, 500},
		{"Endgame 200ms", POSITIONS[4].fen, 200},
	};

	std::printf("  %-20s  %-8s  %-10s  %-12s  %-10s\n", "Job", "Budget", "Elapsed", "Nodes", "Status");
	std::printf("  %s\n", std::string(66, '-').c_str());

	for (const auto& j : jobs) {
		Result r = run(j.fen, 20, j.budgetMs);
		int limit5x = j.budgetMs * 5;
		bool valid = r.move.isValid();
		bool onTime = (int)r.ms < limit5x;
		const char* status = (valid && onTime)
			                     ? "OK"
			                     : (!valid)
			                     ? "NO MOVE"
			                     : "OVERRUN";
		std::printf("  %-20s  %-8d  %-10.0f  %-12lld  %s\n", j.label, j.budgetMs, r.ms, r.stats.totalNodes, status);
		if (!valid)
			std::printf("    << No valid move returned — search did not complete any depth.\n");
		else if (!onTime)
			std::printf("    << Elapsed %.0fms exceeded 5x budget (%dms).\n", r.ms, limit5x);
	}
}

static void bench_summary() {
	std::printf("\n========== 9. MULTI-POSITION SUMMARY TABLE ==========\n");
	std::printf("  Nodes=lower-better  NPS=higher-better  TT%%/FM%%/Q%%=higher-better\n\n");

	std::printf("  %-12s  %-5s  %-12s  %-12s  %-7s  %-7s  %-7s\n",
	            "Position", "D", "Nodes", "NPS", "TT%", "FM%", "Q%");
	std::printf("  %s\n", std::string(72, '-').c_str());

	for (int p = 0; p < N_POSITIONS; ++p) {
		const Pos& pos = POSITIONS[p];
		for (int d : {SEARCH_DEPTH, SEARCH_DEPTH + 2}) {
			Result r = run(pos.fen, d);
			std::printf("  %-12s  %-5d  %-12lld  %-12lld  %5.1f%%  %5.1f%%  %5.1f%%\n",
			            pos.label, d,
			            r.stats.totalNodes,
			            nps(r.stats.totalNodes, r.ms),
			            pct(r.stats.ttHits, r.stats.totalNodes),
			            pct(r.stats.firstMoveCutoffs, r.stats.betaCutoffs),
			            pct(r.stats.qNodes, r.stats.totalNodes));
		}
		std::printf("\n");
	}
}

int main() {
	auto now = std::chrono::system_clock::now();
	std::time_t now_t = std::chrono::system_clock::to_time_t(now);
	std::tm* tm = std::localtime(&now_t);

	std::ostringstream fn;
	fn << "search_performance_" << std::put_time(tm, "%Y%m%d_%H%M%S") << ".txt";

	fs::path cur = fs::current_path();
	std::string cname = cur.filename().string();
	fs::path outDir = (cname == "build" || cname.find("cmake-build") != std::string::npos)
		                  ? cur.parent_path() / "tests" / "Performance" / "results"
		                  : cur / "tests" / "Performance" / "results";

	fs::create_directories(outDir);
	fs::path fullPath = outDir / fn.str();

	std::cerr << "Running search performance diagnostics...\n";
	std::cerr << "Output: " << fullPath.string() << "\n";

	if (!std::freopen(fullPath.string().c_str(), "w", stdout)) {
		std::cerr << "Error: Cannot open output file.\n";
		return 1;
	}

	char timeBuf[64];
	std::strftime(timeBuf, sizeof(timeBuf), "%Y-%m-%d %H:%M:%S", tm);
	std::printf("Search Performance Diagnostics\n");
	std::printf("Generated: %s\n", timeBuf);
	std::printf("Config: single-threaded, TT=16MB, no time pressure unless noted\n");

	bench_nps();
	bench_node_scaling();
	bench_ebf();
	bench_tt_hit_rate();
	bench_move_ordering();
	bench_qsearch_fraction();
	bench_warm_tt();
	bench_time_control();
	bench_summary();

	std::printf("\n========================================\n");
	std::printf("Done.\n");
	std::fclose(stdout);
	std::cerr << "Done. Results saved to: " << fullPath.string() << "\n";
	return 0;
}
