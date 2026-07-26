#pragma once
#include "board.h"
#include "book.h"
#include "evaluator.h"
#include "search.h"
#include "transpositionTable.h"
#include "timeManager.h"
#include <thread>
#include <atomic>
#include <vector>
#include <string>

struct PlaySettings {
    int depth;
    int time_left_ms;
    int increment_ms;
    int moves_to_go;
    bool infinite = false;
};

struct BenchSettings;

class Engine {
public:
    Engine();
    ~Engine();

    void reset();
    bool setPosition(const std::string& fen);

    std::string playMove(const PlaySettings& settings);

    void stopSearch();
    void waitSearch();
    bool isSearching() const { return is_searching.load(); }
    void setSearching(bool val) { is_searching.store(val); }

    std::string getFEN() const;
    int evaluateCurrentPosition();
    bool applyMove(const std::string& uci);
    bool isGameOver() const;

    Board& getBoard() { return board; }
    const Board& getBoard() const { return board; }
    Book& getOpeningBook() { return opening_book; }
    const Book& getOpeningBook() const { return opening_book; }

    bool loadOpeningBook(const std::string& path) { return opening_book.load(path); }
    void setUseBook(bool on) { use_book = on; }

    // Tuned evaluation parameters. Only call between searches — mutating the
    // evaluator (shared by reference with the searcher) mid-search is unsafe.
    bool loadEvalParams(const std::string& path) { return evaluator.loadParametersFromFile(path); }
    std::string exportEvalParams() const { return evaluator.exportParameters(); }
    int evalParamCount() const { return evaluator.getParameterCount(); }

    void setBookMaxFullmove(int n) { book_max_fullmove = n; }
    int bookMaxFullmove() const { return book_max_fullmove; }

    // UCI options. Only call between searches — the TT resize is not safe
    // against a running search.
    void setHashSize(int mb) { tt.resize(mb); }
    void setThreadCount(int n) { searcher.setThreadCount(n); }
    int threadCount() const { return searcher.getThreadCount(); }

    std::thread searchThread;

private:
    Board board;
    std::vector<std::string> history;

    TranspositionTable tt;
    Evaluator evaluator;
    Search searcher;

    Book opening_book;
    // TODO: use_book defaults to true even when no book file is loaded, which causes
    // handle_uci to advertise "OwnBook default true" while the feature is effectively off.
    // Consider defaulting to false and flipping to true only on a successful BookFile load.
    bool use_book = true;
    int book_max_fullmove = 20;

    std::atomic<bool> is_searching{false};

    friend class Bench;
};
