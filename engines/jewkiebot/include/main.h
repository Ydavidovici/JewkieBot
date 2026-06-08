#pragma once
#include "board.h"
#include "book.h"
#include "evaluator.h"
#include "search.h"
#include "transpositionTable.h"
#include "timeManager.h"
#include <vector>
#include <string>

struct PlaySettings {
    int depth;
    int time_left_ms;
    int increment_ms;
    int moves_to_go;
};

struct BenchSettings;

class Engine {
public:
    Engine();
    ~Engine();

    void reset();
    bool setPosition(const std::string &fen);

    std::string playMove(const PlaySettings &settings);

    std::string getFEN() const;
    int evaluateCurrentPosition();
    bool applyMove(const std::string &uci);
    bool isGameOver() const;

    Board& getBoard() { return board; }
    const Board& getBoard() const { return board; }
    Book& getOpeningBook() { return opening_book; }
    const Book& getOpeningBook() const { return opening_book; }

    bool loadOpeningBook(const std::string& path) { return opening_book.load(path); }
    void setUseBook(bool on) { use_book = on; }
    void setBookMaxFullmove(int n) { book_max_fullmove = n; }
    int bookMaxFullmove() const { return book_max_fullmove; }

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

    friend class Bench;
};
