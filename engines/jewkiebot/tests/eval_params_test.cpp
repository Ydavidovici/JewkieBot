// Evaluation parameters (doc 04): the trace the tuner relies on, the params
// file format, and color symmetry.

#include <cassert>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "board.h"
#include "evaluator.h"

static const char* FENS[] = {
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "r1bq1rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQR1K1 w - - 0 1",
    "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "8/8/1p1k4/1P6/8/3p3P/1r4P1/5K2 w - - 0 1",
    "6k1/5ppp/8/8/8/8/1r6/2R1R1K1 b - - 0 1",
    "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1",
    "2r3k1/pp3ppp/4p3/3pP3/3P2Q1/P4N2/1q3PPP/R4RK1 b - - 0 20",
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
};

static int failures = 0;
static void check(bool ok, const std::string& what) {
    std::cout << "  " << (ok ? "ok  " : "FAIL") << " " << what << "\n";
    if (!ok) failures++;
}

// The trace times the parameters, tapered, must reproduce evaluate() exactly:
// that is what lets the tuner work from traces instead of boards.
static void test_trace_reproduces_evaluate() {
    std::cout << "--- trace reproduces evaluate ---\n";
    Evaluator ev;
    for (const char* fen : FENS) {
        Board b(fen);
        const Evaluator::Trace t = ev.trace(b);
        long mg = 0, eg = 0;
        for (auto [param, count] : t.terms) {
            mg += static_cast<long>(count) * ev.getParameter(2 * param);
            eg += static_cast<long>(count) * ev.getParameter(2 * param + 1);
        }
        const long linear = (mg * t.phase + eg * (Evaluator::PHASE_MAX - t.phase)) / Evaluator::PHASE_MAX
                          + static_cast<long>(t.kings) * Evaluator::KING_VALUE;
        const int direct = ev.evaluate(b, Color::WHITE);
        check(linear == direct, std::string(fen) + ": trace " + std::to_string(linear) +
                                " vs evaluate " + std::to_string(direct));
    }
}

// Mirror a FEN vertically and swap colors: the same position for the other
// side. The evaluation from the side to move's view must not change.
static std::string mirrorFen(const std::string& fen) {
    std::istringstream in(fen);
    std::string placement, stm, castling, ep, half, full;
    in >> placement >> stm >> castling >> ep >> half >> full;

    std::vector<std::string> ranks;
    std::string rank;
    for (char c : placement) {
        if (c == '/') { ranks.push_back(rank); rank.clear(); }
        else rank += std::isupper(static_cast<unsigned char>(c)) ? char(std::tolower(c)) : char(std::toupper(c));
    }
    ranks.push_back(rank);
    std::string mirrored;
    for (int i = static_cast<int>(ranks.size()) - 1; i >= 0; --i) {
        mirrored += ranks[i];
        if (i) mirrored += '/';
    }

    std::string castle;
    for (char c : std::string("KQkq")) {
        char swapped = std::isupper(static_cast<unsigned char>(c)) ? char(std::tolower(c)) : char(std::toupper(c));
        if (castling.find(swapped) != std::string::npos) castle += c;
    }
    if (castle.empty()) castle = "-";
    if (ep != "-") ep[1] = (ep[1] == '3') ? '6' : '3';

    return mirrored + " " + (stm == "w" ? "b" : "w") + " " + castle + " " + ep + " " + half + " " + full;
}

static void test_color_symmetry() {
    std::cout << "--- color symmetry ---\n";
    Evaluator ev;
    for (const char* fen : FENS) {
        Board a(fen);
        Board b(mirrorFen(fen));
        const int sa = ev.evaluate(a, a.sideToMove());
        const int sb = ev.evaluate(b, b.sideToMove());
        check(sa == sb, std::string(fen) + ": " + std::to_string(sa) + " vs mirrored " + std::to_string(sb));
    }
}

static std::string writeTemp(const std::string& name, const std::string& content) {
    std::ofstream(name) << content;
    return name;
}

static void test_params_file() {
    std::cout << "--- params file ---\n";
    const Board start(FENS[1]);

    // Round trip: change a value, export, load into a fresh evaluator.
    Evaluator tuned;
    tuned.setParameter(2 * EvalParam::BISHOP_PAIR, 77);
    tuned.setParameter(2 * EvalParam::TEMPO + 1, 9);
    const std::string good = writeTemp("eval_params_test_good.txt", tuned.exportParameters());
    Evaluator loaded;
    std::string error;
    const bool ok = loaded.loadParametersFromFile(good, &error);
    check(ok, "a file written by exportParameters loads" + (ok ? "" : " (" + error + ")"));
    bool same = true;
    for (int i = 0; i < tuned.getParameterCount(); ++i) same &= tuned.getParameter(i) == loaded.getParameter(i);
    check(same, "every value round-trips");
    check(loaded.evaluate(start, Color::WHITE) == tuned.evaluate(start, Color::WHITE), "and evaluates the same");

    // Refusals leave the evaluator untouched.
    const std::string body = tuned.exportParameters().substr(tuned.exportParameters().find('\n') + 1);
    struct Bad { const char* label; std::string content; };
    const Bad bad[] = {
        {"no header (the old v1 layout)", body},
        {"wrong version", "# jewkiebot-eval v1 820\n" + body},
        {"wrong count in header", "# jewkiebot-eval v2 410\n" + body},
        {"too few values", Evaluator::paramsFileHeader() + "\n1\n2\n3\n"},
        {"extra values", tuned.exportParameters() + "5\n"},
    };
    for (const auto& b : bad) {
        Evaluator fresh;
        const int before = fresh.evaluate(start, Color::WHITE);
        std::string why;
        const bool loadedBad = fresh.loadParametersFromFile(writeTemp("eval_params_test_bad.txt", b.content), &why);
        check(!loadedBad && fresh.evaluate(start, Color::WHITE) == before,
              std::string("refuses ") + b.label + " (" + why + ")");
    }
    Evaluator fresh;
    check(!fresh.loadParametersFromFile("no_such_eval_params_file.txt"), "refuses a missing file");

    std::remove("eval_params_test_good.txt");
    std::remove("eval_params_test_bad.txt");
}

int main() {
    test_trace_reproduces_evaluate();
    test_color_symmetry();
    test_params_file();
    if (failures) {
        std::cout << failures << " EVAL PARAMS CHECK(S) FAILED\n";
        return 1;
    }
    std::cout << "ALL EVAL PARAMS TESTS PASSED\n";
    return 0;
}
