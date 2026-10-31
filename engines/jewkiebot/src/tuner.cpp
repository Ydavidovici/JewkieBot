// Texel tuning, linear form (doc 04 step 3; after Andrew Grant, "Evaluation &
// Tuning in Chess Engines").
//
// Each position is reduced once to its trace: which parameters the evaluation
// uses, how many times (White minus Black), and the game phase. The eval is
// then linear in the parameters,
//
//     E = (sum c_i * mg_i * phase + sum c_i * eg_i * (24 - phase)) / 24
//
// so the predicted score sigmoid(K * E) and its exact gradient cost one pass
// over the traces, for all parameters at once. K (how steeply eval maps to
// win probability on this data) is fitted first and then held fixed; Adam
// then minimises the mean squared error against the game results. Every
// tenth position is held out to report validation error.

#include "evaluator.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct Dataset {
    std::vector<std::pair<int16_t, int16_t>> terms;   // all positions' traces, back to back
    std::vector<uint32_t> start;                      // position j's terms: [start[j], start[j + 1])
    std::vector<uint8_t> phase;
    std::vector<int8_t> kings;
    std::vector<float> result;                        // 1 white win, 0.5 draw, 0 black win
    size_t size() const { return result.size(); }
};

// "<fen> c9 \"<result>\";" with the result as 1-0 / 0-1 / 1/2-1/2 or 1.0 / 0.5 / 0.0.
bool parseLine(const std::string& line, std::string& fen, float& result) {
    const size_t c9 = line.find("c9 \"");
    if (c9 == std::string::npos || c9 == 0) return false;
    fen = line.substr(0, c9 - 1);
    const size_t rs = c9 + 4;
    const size_t re = line.find('"', rs);
    if (re == std::string::npos) return false;
    const std::string r = line.substr(rs, re - rs);
    if (r == "1-0" || r == "1.0" || r == "1") result = 1.0f;
    else if (r == "0-1" || r == "0.0" || r == "0") result = 0.0f;
    else if (r == "1/2-1/2" || r == "0.5") result = 0.5f;
    else return false;
    return true;
}

double sigmoid(double k, double eval) { return 1.0 / (1.0 + std::pow(10.0, -k * eval / 400.0)); }

struct Model {
    std::vector<double> mg, eg;   // per EvalParam

    double eval(const Dataset& d, size_t j) const {
        double m = 0, e = 0;
        for (uint32_t t = d.start[j]; t < d.start[j + 1]; ++t) {
            m += d.terms[t].second * mg[d.terms[t].first];
            e += d.terms[t].second * eg[d.terms[t].first];
        }
        const double ph = d.phase[j];
        return (m * ph + e * (Evaluator::PHASE_MAX - ph)) / Evaluator::PHASE_MAX
             + double(d.kings[j]) * Evaluator::KING_VALUE;
    }

    double mse(const Dataset& d, double k) const {
        double total = 0;
        for (size_t j = 0; j < d.size(); ++j) {
            const double diff = d.result[j] - sigmoid(k, eval(d, j));
            total += diff * diff;
        }
        return total / double(d.size());
    }
};

// Golden-section search for the K that minimises MSE with the current params.
double fitK(const Model& model, const Dataset& d) {
    double lo = 0.1, hi = 4.0;
    const double g = (std::sqrt(5.0) - 1) / 2;
    double a = hi - g * (hi - lo), b = lo + g * (hi - lo);
    double fa = model.mse(d, a), fb = model.mse(d, b);
    for (int i = 0; i < 40; ++i) {
        if (fa < fb) { hi = b; b = a; fb = fa; a = hi - g * (hi - lo); fa = model.mse(d, a); }
        else         { lo = a; a = b; fa = fb; b = lo + g * (hi - lo); fb = model.mse(d, b); }
    }
    return (lo + hi) / 2;
}

} // namespace

bool Evaluator::tuneFromDataset(const std::string& datasetPath, const std::string& outputPath,
                                int maxEpochs, const std::function<void(int, double)>& onEpoch) {
    using clock = std::chrono::steady_clock;
    const auto t0 = clock::now();
    auto seconds = [&] { return std::chrono::duration<double>(clock::now() - t0).count(); };

    // 1. Read and trace the dataset. Positions in check are skipped: their
    //    static eval says little about the result (the dataset should be
    //    quiet anyway; zurichess's quiet-labeled set is).
    std::ifstream file(datasetPath);
    if (!file.is_open()) return false;

    Dataset train, valid;
    std::string line, fen;
    size_t lineNo = 0, skipped = 0;
    while (std::getline(file, line)) {
        float result;
        if (!parseLine(line, fen, result)) continue;
        Board board(fen);
        if (board.inCheck(board.sideToMove())) { ++skipped; continue; }

        Dataset& d = (lineNo++ % 10 == 9) ? valid : train;
        const Trace t = trace(board);
        d.start.push_back(static_cast<uint32_t>(d.terms.size()));
        d.terms.insert(d.terms.end(), t.terms.begin(), t.terms.end());
        d.phase.push_back(static_cast<uint8_t>(t.phase));
        d.kings.push_back(static_cast<int8_t>(t.kings));
        d.result.push_back(result);
    }
    train.start.push_back(static_cast<uint32_t>(train.terms.size()));
    valid.start.push_back(static_cast<uint32_t>(valid.terms.size()));
    if (train.size() == 0) return false;

    std::cout << "info string tune: " << train.size() << " training, " << valid.size()
              << " validation positions (" << skipped << " in check skipped), traced in "
              << seconds() << " s\n" << std::flush;

    // 2. Start from the current parameters and fit K to them.
    Model model;
    model.mg.resize(EvalParam::COUNT);
    model.eg.resize(EvalParam::COUNT);
    for (int p = 0; p < EvalParam::COUNT; ++p) {
        model.mg[p] = getParameter(2 * p);
        model.eg[p] = getParameter(2 * p + 1);
    }
    const double k = fitK(model, train);
    std::cout << "info string tune: K = " << k << ", validation mse " << model.mse(valid, k) << "\n" << std::flush;
    if (onEpoch) onEpoch(0, model.mse(train, k));

    // 3. Adam on the exact gradient, full batch.
    constexpr double LR = 1.0, BETA1 = 0.9, BETA2 = 0.999, EPS = 1e-8;
    constexpr int REPORT_EVERY = 50, PATIENCE = 300;   // epochs
    const double kScale = k * std::log(10.0) / 400.0;   // d sigmoid / d eval = kScale * s * (1 - s)

    std::vector<double> gradMg(EvalParam::COUNT), gradEg(EvalParam::COUNT);
    std::vector<double> mMg(EvalParam::COUNT), vMg(EvalParam::COUNT), mEg(EvalParam::COUNT), vEg(EvalParam::COUNT);
    Model best = model;
    double bestValid = valid.size() ? model.mse(valid, k) : 0;
    int bestEpoch = 0;

    for (int epoch = 1; epoch <= maxEpochs; ++epoch) {
        std::fill(gradMg.begin(), gradMg.end(), 0.0);
        std::fill(gradEg.begin(), gradEg.end(), 0.0);
        double loss = 0;

        for (size_t j = 0; j < train.size(); ++j) {
            const double s = sigmoid(k, model.eval(train, j));
            const double diff = train.result[j] - s;
            loss += diff * diff;
            // d(diff^2)/dE = -2 * diff * s * (1 - s) * kScale
            const double dE = -2.0 * diff * s * (1.0 - s) * kScale;
            const double ph = train.phase[j];
            const double wMg = dE * ph / PHASE_MAX, wEg = dE * (PHASE_MAX - ph) / PHASE_MAX;
            for (uint32_t t = train.start[j]; t < train.start[j + 1]; ++t) {
                const auto [param, count] = train.terms[t];
                gradMg[param] += wMg * count;
                gradEg[param] += wEg * count;
            }
        }

        const double n = double(train.size());
        const double c1 = 1.0 - std::pow(BETA1, epoch), c2 = 1.0 - std::pow(BETA2, epoch);
        for (int p = 0; p < EvalParam::COUNT; ++p) {
            const double gm = gradMg[p] / n, ge = gradEg[p] / n;
            mMg[p] = BETA1 * mMg[p] + (1 - BETA1) * gm;  vMg[p] = BETA2 * vMg[p] + (1 - BETA2) * gm * gm;
            mEg[p] = BETA1 * mEg[p] + (1 - BETA1) * ge;  vEg[p] = BETA2 * vEg[p] + (1 - BETA2) * ge * ge;
            model.mg[p] -= LR * (mMg[p] / c1) / (std::sqrt(vMg[p] / c2) + EPS);
            model.eg[p] -= LR * (mEg[p] / c1) / (std::sqrt(vEg[p] / c2) + EPS);
        }

        if (epoch % REPORT_EVERY == 0 || epoch == maxEpochs) {
            const double v = valid.size() ? model.mse(valid, k) : 0;
            if (onEpoch) onEpoch(epoch, loss / n);
            std::cout << "info string tune: epoch " << epoch << " train " << loss / n
                      << " validation " << v << " (" << seconds() << " s)\n" << std::flush;
            if (!valid.size() || v < bestValid) { bestValid = v; best = model; bestEpoch = epoch; }
            else if (epoch - bestEpoch >= PATIENCE) {
                std::cout << "info string tune: validation stopped improving at epoch " << bestEpoch << "\n";
                break;
            }
        }
    }

    // 4. Apply the best (by validation) parameters, rounded, and write them.
    for (int p = 0; p < EvalParam::COUNT; ++p) {
        setParameter(2 * p, static_cast<int>(std::lround(best.mg[p])));
        setParameter(2 * p + 1, static_cast<int>(std::lround(best.eg[p])));
    }
    std::cout << "info string tune: kept epoch " << bestEpoch << ", validation mse " << bestValid
              << ", total " << seconds() << " s\n" << std::flush;

    std::ofstream out(outputPath);
    if (!out.is_open()) return false;
    out << exportParameters();
    return true;
}
