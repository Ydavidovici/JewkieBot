#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdlib>
#include <iostream>

#include "move.h"
#include "transpositionTable.h"

#define REQUIRE(cond) \
    do { \
        if (!(cond)) { \
            std::cerr << "FAIL [" << __FILE__ << ":" << __LINE__ << "]: " #cond "\n"; \
            std::abort(); \
        } \
    } while (0)

#define REQUIRE_MSG(cond, msg) \
    do { \
        if (!(cond)) { \
            std::cerr << "FAIL [" << __FILE__ << ":" << __LINE__ << "]: " << (msg) << "\n"; \
            std::abort(); \
        } \
    } while (0)

static Move mv(const char* uci) { return Move::fromUCI(uci); }

static void check_entry(const char* ctx,
                        const TranspositionTable::TTEntry& e,
                        int val, int depth, int flag) {
	if (e.value != val || e.depth != depth || e.flag != flag) {
		std::cerr << ctx << " – entry mismatch\n"
			<< "  expected: value=" << val << " depth=" << depth << " flag=" << flag << "\n"
			<< "  got:      value=" << e.value << " depth=" << e.depth << " flag=" << e.flag << "\n";
		std::abort();
	}
}

static void test_store_and_probe_value() {
	std::cout << "--- test_store_and_probe_value ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0xAAAA;
	Move m = mv("e2e4");

	tt.store(key, 100, 5, m, TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE_MSG(found, "stored entry must be found");
	check_entry("test_store_and_probe_value", out, 100, 5, TranspositionTable::EXACT);
	REQUIRE_MSG(out.bestMove == m, "stored move must be returned");
	std::cout << "PASS\n\n";
}

static void test_store_negative_value() {
	std::cout << "--- test_store_negative_value ---\n";
	TranspositionTable tt(1);

	tt.store(0xBBBB, -250, 4, mv("d2d4"), TranspositionTable::UPPERBOUND);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(0xBBBB, out);
	REQUIRE(found);
	check_entry("test_store_negative_value", out, -250, 4, TranspositionTable::UPPERBOUND);
	std::cout << "PASS\n\n";
}

static void test_flag_exact_round_trip() {
	std::cout << "--- test_flag_exact_round_trip ---\n";
	TranspositionTable tt(1);
	tt.store(0x1111, 42, 3, mv("g1f3"), TranspositionTable::EXACT);
	TranspositionTable::TTEntry out;
	bool found = tt.probe(0x1111, out);
	REQUIRE(found);
	REQUIRE(out.flag == TranspositionTable::EXACT);
	std::cout << "PASS\n\n";
}

static void test_flag_lowerbound_round_trip() {
	std::cout << "--- test_flag_lowerbound_round_trip ---\n";
	TranspositionTable tt(1);
	tt.store(0x2222, 75, 6, mv("c2c4"), TranspositionTable::LOWERBOUND);
	TranspositionTable::TTEntry out;
	bool found = tt.probe(0x2222, out);
	REQUIRE(found);
	REQUIRE(out.flag == TranspositionTable::LOWERBOUND);
	std::cout << "PASS\n\n";
}

static void test_flag_upperbound_round_trip() {
	std::cout << "--- test_flag_upperbound_round_trip ---\n";
	TranspositionTable tt(1);
	tt.store(0x3333, -30, 2, mv("b1c3"), TranspositionTable::UPPERBOUND);
	TranspositionTable::TTEntry out;
	bool found = tt.probe(0x3333, out);
	REQUIRE(found);
	REQUIRE(out.flag == TranspositionTable::UPPERBOUND);
	std::cout << "PASS\n\n";
}

static void test_probe_empty_table_returns_false() {
	std::cout << "--- test_probe_empty_table_returns_false ---\n";
	TranspositionTable tt(1);
	TranspositionTable::TTEntry out;

	bool a = tt.probe(0x1ULL, out);
	bool b = tt.probe(0xABCDULL, out);
	bool c = tt.probe(0xDEADBEEFCAFEBABEULL, out);

	REQUIRE_MSG(!a && !b && !c, "fresh TT must not return any entry for a non-zero key");
	std::cout << "PASS\n\n";
}

static void test_same_key_deeper_replaces_shallower() {
	std::cout << "--- test_same_key_deeper_replaces_shallower ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0x4444;

	tt.store(key, 10, 2, mv("e2e4"), TranspositionTable::LOWERBOUND);
	tt.store(key, 80, 10, mv("g1f3"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE(found);
	check_entry("test_same_key_deeper_replaces_shallower", out, 80, 10, TranspositionTable::EXACT);
	REQUIRE(out.bestMove == mv("g1f3"));
	std::cout << "PASS\n\n";
}

static void test_same_key_shallower_must_not_overwrite_deeper() {
	std::cout << "--- test_same_key_shallower_must_not_overwrite_deeper ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0x5555;
	Move deepMove = mv("e2e4");
	Move shallowMove = mv("d2d4");

	tt.store(key, 300, 8, deepMove, TranspositionTable::EXACT);
	tt.store(key, 20, 2, shallowMove, TranspositionTable::LOWERBOUND);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE(found);
	REQUIRE_MSG(out.depth == 8,
	            "shallower same-key store must not overwrite a deeper entry");
	REQUIRE_MSG(out.value == 300,
	            "value from deeper search must survive a shallower re-store");
	REQUIRE_MSG(out.flag == TranspositionTable::EXACT,
	            "flag from deeper search must survive a shallower re-store");
	REQUIRE_MSG(out.bestMove == deepMove,
	            "best move from deeper search must survive a shallower re-store");
	std::cout << "PASS\n\n";
}

static void test_same_key_equal_depth_updates() {
	std::cout << "--- test_same_key_equal_depth_updates ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0x6666;

	tt.store(key, 50, 4, mv("e2e4"), TranspositionTable::UPPERBOUND);
	tt.store(key, 75, 4, mv("g1f3"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE(found);
	check_entry("test_same_key_equal_depth_updates", out, 75, 4, TranspositionTable::EXACT);
	std::cout << "PASS\n\n";
}

static void test_collision_deeper_wins() {
	std::cout << "--- test_collision_deeper_wins ---\n";
	TranspositionTable tt(1);
	size_t numEntries = (1ULL * 1024 * 1024) / sizeof(TranspositionTable::TTEntry);
	uint64_t key1 = 0x100;
	uint64_t key2 = key1 + numEntries;

	tt.store(key1, 50, 3, mv("e2e4"), TranspositionTable::EXACT);
	tt.store(key2, 80, 6, mv("d2d4"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found2 = tt.probe(key2, out);
	REQUIRE_MSG(found2, "deeper collision entry must be stored");
	check_entry("test_collision_deeper_wins", out, 80, 6, TranspositionTable::EXACT);

	bool found1 = tt.probe(key1, out);
	REQUIRE_MSG(!found1, "shallower collision entry must have been evicted");
	std::cout << "PASS\n\n";
}

static void test_collision_shallower_does_not_evict_deeper() {
	std::cout << "--- test_collision_shallower_does_not_evict_deeper ---\n";
	TranspositionTable tt(1);
	size_t numEntries = (1ULL * 1024 * 1024) / sizeof(TranspositionTable::TTEntry);
	uint64_t key1 = 0x200;
	uint64_t key2 = key1 + numEntries;

	tt.store(key1, 90, 8, mv("g1f3"), TranspositionTable::EXACT);
	tt.store(key2, 20, 2, mv("c2c4"), TranspositionTable::LOWERBOUND);

	TranspositionTable::TTEntry out;
	bool found1 = tt.probe(key1, out);
	REQUIRE_MSG(found1, "deeper entry must survive a shallower collision attempt");
	check_entry("test_collision_shallower_does_not_evict_deeper", out, 90, 8, TranspositionTable::EXACT);

	bool found2 = tt.probe(key2, out);
	REQUIRE_MSG(!found2, "shallower collision entry must not displace the deeper one");
	std::cout << "PASS\n\n";
}

static void test_probe_unstored_key_returns_false() {
	std::cout << "--- test_probe_unstored_key_returns_false ---\n";
	TranspositionTable tt(1);
	tt.store(0xAAAABBBB, 100, 5, mv("e2e4"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(0xDEADBEEF, out);
	REQUIRE_MSG(!found, "a never-stored key must not probe successfully");
	std::cout << "PASS\n\n";
}

static void test_probe_key_zero_should_miss_on_empty_table() {
	std::cout << "--- test_probe_key_zero_should_miss_on_empty_table ---\n";
	TranspositionTable tt(1);
	TranspositionTable::TTEntry out;
	bool found = tt.probe(0ULL, out);
	REQUIRE_MSG(!found, "key=0 on an empty TT must not be a false hit");
	std::cout << "PASS\n\n";
}

static void test_invalid_move_does_not_overwrite_stored_move() {
	std::cout << "--- test_invalid_move_does_not_overwrite_stored_move ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0x7777;
	Move original = mv("e4f6");

	tt.store(key, 100, 5, original, TranspositionTable::EXACT);
	tt.store(key, 200, 6, Move(), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE(found);
	REQUIRE_MSG(out.bestMove == original, "null bestMove on re-store must not overwrite the existing valid move");
	std::cout << "PASS\n\n";
}

static void test_valid_move_overwrites_stored_move() {
	std::cout << "--- test_valid_move_overwrites_stored_move ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0x8888;

	tt.store(key, 50, 3, mv("e2e4"), TranspositionTable::EXACT);
	tt.store(key, 80, 5, mv("d7d5"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE(found);
	REQUIRE_MSG(out.bestMove == mv("d7d5"), "new valid bestMove must overwrite existing one");
	std::cout << "PASS\n\n";
}

static void test_exact_flag_enables_direct_return() {
	std::cout << "--- test_exact_flag_enables_direct_return ---\n";
	TranspositionTable tt(1);
	tt.store(0x9999, 150, 5, mv("e2e4"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry ent;
	bool found = tt.probe(0x9999, ent);
	REQUIRE(found);
	REQUIRE(ent.depth >= 4);
	REQUIRE(ent.flag == TranspositionTable::EXACT);
	REQUIRE(ent.value == 150);
	std::cout << "PASS\n\n";
}

static void test_lowerbound_tightens_alpha() {
	std::cout << "--- test_lowerbound_tightens_alpha ---\n";
	TranspositionTable tt(1);
	tt.store(0xAAA1, 60, 5, mv("g1f3"), TranspositionTable::LOWERBOUND);

	TranspositionTable::TTEntry ent;
	bool found = tt.probe(0xAAA1, ent);
	REQUIRE(found);
	REQUIRE(ent.flag == TranspositionTable::LOWERBOUND);

	int alpha = 30, beta = 90;
	alpha = std::max(alpha, ent.value);
	REQUIRE_MSG(alpha == 60, "LOWERBOUND must raise alpha");
	REQUIRE_MSG(alpha < beta, "no cutoff at these bounds");

	alpha = std::max(30, ent.value);
	beta = 50;
	REQUIRE_MSG(alpha >= beta, "LOWERBOUND >= beta must cause a cutoff");
	std::cout << "PASS\n\n";
}

static void test_upperbound_tightens_beta() {
	std::cout << "--- test_upperbound_tightens_beta ---\n";
	TranspositionTable tt(1);
	tt.store(0xBBB1, 40, 5, mv("b1c3"), TranspositionTable::UPPERBOUND);

	TranspositionTable::TTEntry ent;
	bool found = tt.probe(0xBBB1, ent);
	REQUIRE(found);
	REQUIRE(ent.flag == TranspositionTable::UPPERBOUND);

	int alpha = 10, beta = 90;
	beta = std::min(beta, ent.value);
	REQUIRE_MSG(beta == 40, "UPPERBOUND must lower beta");
	REQUIRE_MSG(alpha < beta, "no cutoff at these bounds");

	alpha = 50;
	beta = std::min(90, ent.value);
	REQUIRE_MSG(alpha >= beta, "UPPERBOUND <= alpha must cause a cutoff");
	std::cout << "PASS\n\n";
}

static void test_insufficient_depth_score_must_not_be_used() {
	std::cout << "--- test_insufficient_depth_score_must_not_be_used ---\n";
	TranspositionTable tt(1);
	tt.store(0xCCC1, 99, 2, mv("d2d4"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry ent;
	bool found = tt.probe(0xCCC1, ent);
	REQUIRE(found);

	int searchDepth = 5;
	REQUIRE_MSG(ent.depth < searchDepth,
	            "stored depth must be insufficient for this node");
	REQUIRE_MSG(ent.bestMove == mv("d2d4"),
	            "bestMove is usable for move ordering regardless of depth");
	std::cout << "PASS\n\n";
}

static void test_clear_removes_stored_entries() {
	std::cout << "--- test_clear_removes_stored_entries ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0xDDDD;

	tt.store(key, 77, 4, mv("e2e4"), TranspositionTable::EXACT);
	{
		TranspositionTable::TTEntry out;
		bool before = tt.probe(key, out);
		REQUIRE_MSG(before, "entry must be found before clear");
	}

	tt.clear();

	TranspositionTable::TTEntry out;
	bool after = tt.probe(key, out);
	REQUIRE_MSG(!after, "entry must not survive clear()");
	std::cout << "PASS\n\n";
}

static void test_store_after_clear_works() {
	std::cout << "--- test_store_after_clear_works ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0xEEEE;

	tt.store(key, 10, 2, mv("b1c3"), TranspositionTable::LOWERBOUND);
	tt.clear();
	tt.store(key, 50, 6, mv("g1f3"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE_MSG(found, "entry stored after clear() must be found");
	check_entry("test_store_after_clear_works", out, 50, 6, TranspositionTable::EXACT);
	std::cout << "PASS\n\n";
}

static void test_mate_score_values_survive() {
	std::cout << "--- test_mate_score_values_survive ---\n";
	TranspositionTable tt(1);
	constexpr int MATE = 100000;

	tt.store(0x1001, +MATE, 5, mv("e2e4"), TranspositionTable::EXACT);
	tt.store(0x1002, -MATE, 5, mv("d2d4"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool f1 = tt.probe(0x1001, out);
	REQUIRE(f1);
	REQUIRE_MSG(out.value == +MATE, "+MATE_SCORE must round-trip through TT");

	bool f2 = tt.probe(0x1002, out);
	REQUIRE(f2);
	REQUIRE_MSG(out.value == -MATE, "-MATE_SCORE must round-trip through TT");
	std::cout << "PASS\n\n";
}

static void test_depth_zero_round_trip() {
	std::cout << "--- test_depth_zero_round_trip ---\n";
	TranspositionTable tt(1);
	tt.store(0x2002, -15, 0, mv("a2a4"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(0x2002, out);
	REQUIRE(found);
	check_entry("test_depth_zero_round_trip", out, -15, 0, TranspositionTable::EXACT);
	std::cout << "PASS\n\n";
}

static void test_many_distinct_keys_all_retrievable() {
	std::cout << "--- test_many_distinct_keys_all_retrievable ---\n";
	TranspositionTable tt(16);
	constexpr int COUNT = 300;

	for (int i = 1; i <= COUNT; ++i) {
		uint64_t key = static_cast<uint64_t>(i);
		int flag = (i % 3 == 0)
			           ? TranspositionTable::EXACT
			           : (i % 3 == 1)
			           ? TranspositionTable::LOWERBOUND
			           : TranspositionTable::UPPERBOUND;
		tt.store(key, i * 7, (i % 7) + 1, mv("e2e4"), flag);
	}

	int hits = 0;
	for (int i = 1; i <= COUNT; ++i) {
		TranspositionTable::TTEntry out;
		bool found = tt.probe(static_cast<uint64_t>(i), out);
		if (found) {
			REQUIRE_MSG(out.value == i * 7, "retrieved value must match stored value");
			++hits;
		}
	}

	REQUIRE_MSG(hits == COUNT, "all 300 distinct entries must be retrievable");
	std::cout << "PASS\n\n";
}

static void test_overwrite_chain_preserves_deepest() {
	std::cout << "--- test_overwrite_chain_preserves_deepest ---\n";
	TranspositionTable tt(1);
	uint64_t key = 0xF001;

	tt.store(key, 10, 1, mv("e2e4"), TranspositionTable::UPPERBOUND);
	tt.store(key, 50, 4, mv("d2d4"), TranspositionTable::LOWERBOUND);
	tt.store(key, 90, 8, mv("g1f3"), TranspositionTable::EXACT);

	TranspositionTable::TTEntry out;
	bool found = tt.probe(key, out);
	REQUIRE(found);
	check_entry("test_overwrite_chain_preserves_deepest", out, 90, 8, TranspositionTable::EXACT);
	REQUIRE(out.bestMove == mv("g1f3"));
	std::cout << "PASS\n\n";
}

int main() {
	std::cout << "========== SECTION 1: Core Store/Probe Correctness ==========\n\n";
	test_store_and_probe_value();
	test_store_negative_value();
	test_flag_exact_round_trip();
	test_flag_lowerbound_round_trip();
	test_flag_upperbound_round_trip();
	test_probe_empty_table_returns_false();

	std::cout << "========== SECTION 2: Replacement Policy ==========\n\n";
	test_same_key_deeper_replaces_shallower();
	test_same_key_shallower_must_not_overwrite_deeper();
	test_same_key_equal_depth_updates();
	test_collision_deeper_wins();
	test_collision_shallower_does_not_evict_deeper();

	std::cout << "========== SECTION 3: Key Miss Semantics ==========\n\n";
	test_probe_unstored_key_returns_false();
	test_probe_key_zero_should_miss_on_empty_table();

	std::cout << "========== SECTION 4: Move Preservation ==========\n\n";
	test_invalid_move_does_not_overwrite_stored_move();
	test_valid_move_overwrites_stored_move();

	std::cout << "========== SECTION 5: Flag / Depth Semantics ==========\n\n";
	test_exact_flag_enables_direct_return();
	test_lowerbound_tightens_alpha();
	test_upperbound_tightens_beta();
	test_insufficient_depth_score_must_not_be_used();

	std::cout << "========== SECTION 6: Table Management ==========\n\n";
	test_clear_removes_stored_entries();
	test_store_after_clear_works();

	std::cout << "========== SECTION 7: Edge Cases ==========\n\n";
	test_mate_score_values_survive();
	test_depth_zero_round_trip();
	test_many_distinct_keys_all_retrievable();
	test_overwrite_chain_preserves_deepest();

	std::cout << "\n========================================\n";
	std::cout << "ALL TRANSPOSITION TABLE TESTS PASSED\n";
	return 0;
}