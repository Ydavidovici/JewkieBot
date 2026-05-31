#include "main.h"

Engine::Engine()
    : tt(64), searcher(evaluator, tt) {
    history.clear();
}

Engine::~Engine() = default;

void Engine::reset() {
    board.loadFEN("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    history.clear();
}

bool Engine::setPosition(const std::string& fen) {
    try {
        board.loadFEN(fen);
        history.clear();
        return true;
    }
    catch (...) {
        return false;
    }
}

std::string Engine::getFEN() const {
    return board.toFEN();
}

int Engine::evaluateCurrentPosition() {
    return evaluator.evaluate(board, board.sideToMove());
}

bool Engine::applyMove(const std::string& moveStr) {
    Move parsed_move = Move::fromUCI(moveStr);

    std::vector<Move> legal_moves = board.generateLegalMoves();

    for (const Move& legal_move : legal_moves) {
        if (legal_move.start == parsed_move.start &&
            legal_move.end == parsed_move.end &&
            legal_move.promo == parsed_move.promo) {

            return board.makeMove(legal_move);
            }
    }
    return false;
}

std::string Engine::playMove(const PlaySettings& settings) {
    // Book probe: handles transposition naturally (hash-keyed), bounded by fullmove cutoff.
    if (use_book && opening_book.isLoaded() && board.fullmoveNumber() <= book_max_fullmove) {
        Move book_move = opening_book.probe(board);
        if (book_move.isValid()) {
            board.makeMove(book_move);
            std::string uci = book_move.toString();
            history.push_back(uci);
            return uci;
        }
    }

    Move best = searcher.findBestMove(
        board,
        settings.depth,
        settings.time_left_ms,
        settings.increment_ms,
        settings.moves_to_go,
        settings.movetime_ms
    );

    board.makeMove(best);
    std::string uci = best.toString();
    history.push_back(uci);
    return uci;
}

bool Engine::isGameOver() const {
    return board.isCheckmate(board.sideToMove())
        || board.isStalemate(board.sideToMove())
        || board.isFiftyMoveDraw()
        || board.isThreefoldRepetition()
        || board.isInsufficientMaterial();
}

