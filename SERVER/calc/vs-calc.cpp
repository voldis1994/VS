/* VS calc — SUPER C++ EntryReady (stronger than old Node nude/decideEntryFrom10sRegime).
 * Uses ALL feeds + buy/sell pressure + 1m/5m/15m + last-200 bull/bear polarity.
 * Never opens Capital — robotDesk hands execute EntryReady only.
 */
#ifdef _WIN32
#define _WIN32_WINNT 0x0601
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <chrono>
#include <vector>
#include <map>
#include <algorithm>
#include <cctype>
#include <ctime>

#ifdef _WIN32
static void sock_close(SOCKET s) { closesocket(s); }
#else
using SOCKET = int;
static const int INVALID_SOCKET = -1;
static void sock_close(int s) { close(s); }
#endif

static std::string env_or(const char* k, const std::string& fb = {}) {
  const char* v = std::getenv(k);
  return v && *v ? std::string(v) : fb;
}

static bool http(const std::string& method, const std::string& host, int port,
                 const std::string& path, const std::string& token,
                 const std::string& body, std::string* out) {
#ifdef _WIN32
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
  addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0) return false;
  SOCKET s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
  if (s == INVALID_SOCKET) {
    freeaddrinfo(res);
    return false;
  }
  if (connect(s, res->ai_addr, (int)res->ai_addrlen) != 0) {
    sock_close(s);
    freeaddrinfo(res);
    return false;
  }
  freeaddrinfo(res);
  std::ostringstream req;
  req << method << " " << path << " HTTP/1.0\r\nHost: " << host << "\r\n";
  req << "Accept: application/json\r\n";
  if (!token.empty()) req << "x-pipeline-token: " << token << "\r\n";
  if (!body.empty()) {
    req << "Content-Type: application/json\r\nContent-Length: " << body.size() << "\r\n";
  }
  req << "Connection: close\r\n\r\n" << body;
  auto payload = req.str();
#ifdef _WIN32
  send(s, payload.c_str(), (int)payload.size(), 0);
#else
  send(s, payload.c_str(), payload.size(), 0);
#endif
  std::string resp;
  char buf[4096];
  for (;;) {
#ifdef _WIN32
    int n = recv(s, buf, sizeof(buf), 0);
#else
    ssize_t n = recv(s, buf, sizeof(buf), 0);
#endif
    if (n <= 0) break;
    resp.append(buf, buf + n);
  }
  sock_close(s);
  auto pos = resp.find("\r\n\r\n");
  if (pos == std::string::npos) return false;
  if (out) *out = resp.substr(pos + 4);
  auto line = resp.substr(0, resp.find("\r\n"));
  return line.find(" 200") != std::string::npos || line.find(" 204") != std::string::npos;
}

struct Bar { double o{}, h{}, l{}, c{}; };
struct Snap {
  std::string epic;
  std::string regime;
  std::string bias;
  std::string feed_agreement;
  double bid{}, ask{}, mid{};
  double pressure_net{}, pressure_buy{}, pressure_sell{};
  double body_1m{}, body_5m{}, body_15m{};
  int feed_contributing{}, feed_sender_count{};
  int c200_n{}, c200_bull{}, c200_bear{}, c200_doji{};
  std::string plan_direction;
  std::string plan_setup;
  std::string feed_confirm;
  double feed_mid{};
  std::vector<Bar> bars;      // 10s
  std::vector<Bar> bars_1m;
  std::vector<Bar> bars_5m;
  std::vector<Bar> bars_15m;
};

static double json_num(const std::string& s, const char* key, double fb = 0) {
  std::string k = std::string("\"") + key + "\":";
  auto p = s.find(k);
  if (p == std::string::npos) return fb;
  return std::atof(s.c_str() + p + k.size());
}

static std::string json_str(const std::string& s, const char* key) {
  std::string k = std::string("\"") + key + "\":\"";
  auto p = s.find(k);
  if (p == std::string::npos) return {};
  p += k.size();
  auto e = s.find('"', p);
  if (e == std::string::npos) return {};
  return s.substr(p, e - p);
}

static std::vector<Bar> parse_bar_array(const std::string& chunk, const char* key, size_t maxn) {
  std::vector<Bar> out;
  std::string needle = std::string("\"") + key + "\":[";
  auto p = chunk.find(needle);
  if (p == std::string::npos) return out;
  p += needle.size();
  size_t depth = 1;
  size_t i = p;
  while (i < chunk.size() && depth > 0) {
    if (chunk[i] == '[') ++depth;
    else if (chunk[i] == ']') --depth;
    ++i;
  }
  if (depth != 0) return out;
  std::string arr = chunk.substr(p, i - p - 1);
  size_t b = 0;
  while ((b = arr.find('{', b)) != std::string::npos && out.size() < maxn) {
    auto e = arr.find('}', b);
    if (e == std::string::npos) break;
    std::string obj = arr.substr(b, e - b + 1);
    Bar bar;
    bar.o = json_num(obj, "o");
    bar.h = json_num(obj, "h");
    bar.l = json_num(obj, "l");
    bar.c = json_num(obj, "c");
    if (bar.c > 0) out.push_back(bar);
    b = e + 1;
  }
  return out;
}

static std::vector<Snap> parse_snaps(const std::string& json) {
  std::vector<Snap> out;
  size_t i = 0;
  while ((i = json.find("\"epic\"", i)) != std::string::npos) {
    auto end = json.find("\"epic\"", i + 5);
    std::string chunk = json.substr(i, end == std::string::npos ? json.size() - i : end - i);
    Snap s;
    s.epic = json_str(chunk, "epic");
    s.regime = json_str(chunk, "regime");
    s.bias = json_str(chunk, "bias");
    s.feed_agreement = json_str(chunk, "feed_agreement");
    s.bid = json_num(chunk, "bid");
    s.ask = json_num(chunk, "ask");
    s.mid = json_num(chunk, "mid");
    s.pressure_net = json_num(chunk, "pressure_net");
    s.pressure_buy = json_num(chunk, "pressure_buy");
    s.pressure_sell = json_num(chunk, "pressure_sell");
    s.body_1m = json_num(chunk, "body_pressure_1m");
    s.body_5m = json_num(chunk, "body_pressure_5m");
    s.body_15m = json_num(chunk, "body_pressure_15m");
    s.feed_contributing = (int)json_num(chunk, "feed_contributing");
    s.feed_sender_count = (int)json_num(chunk, "feed_sender_count");
    s.c200_n = (int)json_num(chunk, "candle200_n");
    s.c200_bull = (int)json_num(chunk, "candle200_bull");
    s.c200_bear = (int)json_num(chunk, "candle200_bear");
    s.c200_doji = (int)json_num(chunk, "candle200_doji");
    s.plan_direction = json_str(chunk, "plan_direction");
    s.plan_setup = json_str(chunk, "plan_setup");
    s.feed_confirm = json_str(chunk, "feed_confirm");
    s.feed_mid = json_num(chunk, "feed_mid");
    s.bars = parse_bar_array(chunk, "bars", 40);
    s.bars_1m = parse_bar_array(chunk, "bars_1m", 200);
    s.bars_5m = parse_bar_array(chunk, "bars_5m", 40);
    s.bars_15m = parse_bar_array(chunk, "bars_15m", 20);
    if (!s.epic.empty()) out.push_back(s);
    i += 6;
  }
  return out;
}

static std::string upper(std::string s) {
  for (char& ch : s) ch = (char)std::toupper((unsigned char)ch);
  return s;
}

static double net_move(const std::vector<Bar>& bars, size_t n) {
  if (bars.size() < 2) return 0;
  size_t take = std::min(n, bars.size());
  const Bar& a = bars[bars.size() - take];
  const Bar& b = bars.back();
  return (b.c - a.o) / std::max(std::fabs(a.o), 1e-9);
}

static int streak(const std::vector<Bar>& bars) {
  if (bars.size() < 2) return 0;
  int s = 0;
  for (size_t i = 1; i < bars.size(); ++i) {
    if (bars[i].c > bars[i - 1].c) s = s >= 0 ? s + 1 : 1;
    else if (bars[i].c < bars[i - 1].c) s = s <= 0 ? s - 1 : -1;
  }
  return s;
}

static bool dump_bar(const Bar& b) { return b.c < b.o; }
static bool climb_bar(const Bar& b) { return b.c > b.o; }

static double range_pos(const std::vector<Bar>& bars) {
  if (bars.empty()) return 0.5;
  double hi = bars[0].h, lo = bars[0].l;
  for (const auto& b : bars) {
    hi = std::max(hi, b.h);
    lo = std::min(lo, b.l);
  }
  if (hi <= lo) return 0.5;
  return (bars.back().c - lo) / (hi - lo);
}

/** Super entry: multi-TF confluence + pressure + feeds + 200-bar polarity. */
static bool decide(const Snap& s, std::string* dir, std::string* setup, std::string* why, double* ev_out) {
  if (s.bars.empty() && s.bars_1m.empty()) return false;

  const std::string regime = upper(s.regime);
  const std::string bias = upper(s.bias);
  const std::string agree = upper(s.feed_agreement);
  const std::string plan_dir = upper(s.plan_direction);
  const std::string plan_setup = upper(s.plan_setup);
  const std::string feed_confirm = upper(s.feed_confirm);

  bool down_ctx =
    regime.find("TREND_DOWN") != std::string::npos ||
    regime.find("BREAKOUT_DOWN") != std::string::npos ||
    (regime.find("PULLBACK_DOWN") != std::string::npos && regime.find("FAILED") == std::string::npos);
  bool up_ctx =
    regime.find("TREND_UP") != std::string::npos ||
    regime.find("BREAKOUT_UP") != std::string::npos ||
    (regime.find("PULLBACK_UP") != std::string::npos && regime.find("FAILED") == std::string::npos);
  bool failed_bo = regime.find("FAILED_BREAKOUT") != std::string::npos;
  bool range_ctx = regime.find("RANGE") != std::string::npos || regime.find("COMPRESSION") != std::string::npos;

  // --- Last-200 closed 1m polarity (market character) ---
  int bull = s.c200_bull, bear = s.c200_bear, n200 = s.c200_n;
  if (n200 <= 0 && !s.bars_1m.empty()) {
    for (const auto& b : s.bars_1m) {
      if (b.c > b.o) ++bull;
      else if (b.c < b.o) ++bear;
      ++n200;
    }
  }
  double polarity = 0; // +bullish −bearish
  if (n200 > 0) polarity = double(bull - bear) / double(n200);

  // --- Multi-TF net (15m dominant, 5m intermediate, 1m timing) ---
  double n15 = net_move(s.bars_15m, 6);
  double n5 = net_move(s.bars_5m, 8);
  double n1 = net_move(s.bars_1m, 12);
  double n10 = net_move(s.bars, 12);
  int st1 = streak(s.bars_1m);
  int st10 = streak(s.bars);

  bool htf_up = n15 > 0.00015 || (s.bars_15m.size() >= 2 && s.body_15m > 0.08);
  bool htf_down = n15 < -0.00015 || (s.bars_15m.size() >= 2 && s.body_15m < -0.08);
  bool mtf_up = n5 > 0.0001 || s.body_5m > 0.05;
  bool mtf_down = n5 < -0.0001 || s.body_5m < -0.05;
  bool ltf_up = n1 > 0 || st1 >= 2 || s.body_1m > 0.04;
  bool ltf_down = n1 < 0 || st1 <= -2 || s.body_1m < -0.04;

  // When 15m/5m history is thin, proxy from 1m — otherwise HTF stays false → SCAN forever.
  if (s.bars_15m.size() < 2) {
    htf_up = n1 > 0.0002 || s.body_1m > 0.06;
    htf_down = n1 < -0.0002 || s.body_1m < -0.06;
  }
  if (s.bars_5m.size() < 2) {
    mtf_up = n1 > 0.0001 || st1 >= 2 || s.body_1m > 0.04;
    mtf_down = n1 < -0.0001 || st1 <= -2 || s.body_1m < -0.04;
  }

  // Micro impulse from 10s (phone chart climb/dump) — must drive EntryReady.
  const Bar& last10_early = s.bars.empty() ? (s.bars_1m.empty() ? Bar{} : s.bars_1m.back()) : s.bars.back();
  bool climb_early = last10_early.c > last10_early.o;
  bool dump_early = last10_early.c < last10_early.o;
  if (!s.bars.empty() && s.bars.size() >= 2) {
    if (s.bars.back().c > s.bars[s.bars.size() - 2].c) climb_early = true;
    if (s.bars.back().c < s.bars[s.bars.size() - 2].c) dump_early = true;
  }
  bool micro_up = n10 > 0.0002 || st10 >= 2 || (climb_early && (n10 >= 0 || st10 >= 1));
  bool micro_down = n10 < -0.0002 || st10 <= -2 || (dump_early && (n10 <= 0 || st10 <= -1));

  // Bias from Node if present; else infer — 200c daily polarity must NOT veto micro climb.
  bool want_buy = false;
  bool want_sell = false;
  if (bias == "UP") want_buy = true;
  else if (bias == "DOWN") want_sell = true;
  else {
    if (micro_up && (ltf_up || mtf_up || htf_up || n1 > 0 || st10 >= 2)) want_buy = true;
    else if (micro_down && (ltf_down || mtf_down || htf_down || n1 < 0 || st10 <= -2)) want_sell = true;
    else if (htf_up && (mtf_up || polarity > 0.02 || ltf_up)) want_buy = true;
    else if (htf_down && (mtf_down || polarity < -0.02 || ltf_down)) want_sell = true;
    else if (up_ctx) want_buy = true;
    else if (down_ctx) want_sell = true;
    else if (bull > bear + 10 && n200 >= 40 && !micro_down) want_buy = true;
    else if (bear > bull + 10 && n200 >= 40 && !micro_up) want_sell = true;
  }
  // Clear 10s impulse always sets side even if Node bias FLAT / 200c opposite day.
  if (micro_up && (ltf_up || n1 > 0 || st1 >= 1 || n10 > 0.00035 || st10 >= 2)) want_buy = true;
  if (micro_down && (ltf_down || n1 < 0 || st1 <= -1 || n10 < -0.00035 || st10 <= -2)) want_sell = true;
  if (want_buy && want_sell) {
    if (micro_up && !micro_down) want_sell = false;
    else if (micro_down && !micro_up) want_buy = false;
    else if (n10 >= 0) want_sell = false;
    else want_buy = false;
  }

  // Feed quality — use ALL feeds; diverge soft-blocks weak entries
  bool feeds_ok = s.feed_contributing >= 1 && agree != "DIVERGENT";
  bool feeds_strong = s.feed_contributing >= 2 && (agree == "STRONG" || agree == "OK");
  if (!feeds_ok && s.feed_sender_count > 0 && agree == "DIVERGENT") {
    // Still allow only with exceptional multi-TF + pressure alignment
  }

  // Buy / sell pressure (cross-market + body)
  double buy_p = s.pressure_buy + std::max(0.0, s.body_1m) * 0.35 + std::max(0.0, s.body_5m) * 0.25;
  double sell_p = s.pressure_sell + std::max(0.0, -s.body_1m) * 0.35 + std::max(0.0, -s.body_5m) * 0.25;
  if (s.pressure_net > 0.05) buy_p += s.pressure_net;
  if (s.pressure_net < -0.05) sell_p += -s.pressure_net;

  const Bar& last10 = s.bars.empty() ? (s.bars_1m.empty() ? Bar{} : s.bars_1m.back()) : s.bars.back();
  if (last10.c <= 0) return false;
  bool dump = dump_bar(last10) || (!s.bars.empty() && s.bars.size() >= 2 && s.bars.back().c < s.bars[s.bars.size() - 2].c);
  bool climb = climb_bar(last10) || (!s.bars.empty() && s.bars.size() >= 2 && s.bars.back().c > s.bars[s.bars.size() - 2].c);
  double rpos = range_pos(s.bars.empty() ? s.bars_1m : s.bars);
  bool prior_dump = s.bars.size() >= 2 && dump_bar(s.bars[s.bars.size() - 2]);
  bool prior_climb = s.bars.size() >= 2 && climb_bar(s.bars[s.bars.size() - 2]);

  auto score_side = [&](int sign) {
    double p = 0.42;
    // Polarity of last 200 — soft context only (don't let daily chop kill a live move)
    double pol_w = micro_up || micro_down ? 0.08 : 0.18;
    p += pol_w * (sign * polarity);
    bool breakout_reg =
      regime.find("BREAKOUT_UP") != std::string::npos ||
      regime.find("BREAKOUT_DOWN") != std::string::npos;
    bool trend_reg =
      regime.find("TREND_UP") != std::string::npos ||
      regime.find("TREND_DOWN") != std::string::npos ||
      regime.find("PULLBACK_UP") != std::string::npos ||
      regime.find("PULLBACK_DOWN") != std::string::npos ||
      regime.find("EXPANSION") != std::string::npos;
    if (sign > 0) {
      if (htf_up) p += 0.12;
      if (mtf_up) p += 0.08;
      if (ltf_up) p += 0.06;
      if (micro_up) p += 0.16;
      if (bias == "UP") p += 0.1;
      if (htf_down && !micro_up) p -= 0.2;
      p += 0.1 * std::min(1.0, buy_p);
      p -= 0.08 * std::min(1.0, sell_p);
      // Breakouts/trends live at range highs — do NOT punish rpos there.
      if (rpos > 0.88 && !breakout_reg && !trend_reg && !micro_up) p -= 0.22;
    } else {
      if (htf_down) p += 0.12;
      if (mtf_down) p += 0.08;
      if (ltf_down) p += 0.06;
      if (micro_down) p += 0.16;
      if (bias == "DOWN") p += 0.1;
      if (htf_up && !micro_down) p -= 0.2;
      p += 0.1 * std::min(1.0, sell_p);
      p -= 0.08 * std::min(1.0, buy_p);
      if (rpos < 0.12 && !breakout_reg && !trend_reg && !micro_down) p -= 0.22;
    }
    if (feeds_strong) p += 0.06;
    else if (agree == "DIVERGENT") p -= 0.04; // soft only — never SCAN-forever on divergent feeds
    if (sign > 0 && n10 < -0.0004 && !dump && !micro_up) p -= 0.08;
    if (sign < 0 && n10 > 0.0004 && !climb && !micro_down) p -= 0.08;
    p = std::clamp(p, 0.02, 0.98);
    double spread = (s.ask > 0 && s.bid > 0) ? (s.ask - s.bid) / std::max(last10.c, 1.0) : 0.0002;
    return p * 1.0 - (1.0 - p) * 1.0 - spread * 6.0;
  };

  double ev_buy = score_side(1);
  double ev_sell = score_side(-1);

  const double MIN_EV = 0.02;
  const double MIN_EV_MICRO = 0.01;

  auto tf_align_buy = [&]() {
    int a = 0;
    if (htf_up || polarity > 0.04 || micro_up || bias == "UP") ++a;
    if (mtf_up || s.body_5m > 0 || n1 > 0) ++a;
    if (ltf_up || buy_p > sell_p || st10 >= 1 || n10 > 0) ++a;
    if (bull > bear && n200 >= 30) ++a;
    return a;
  };
  auto tf_align_sell = [&]() {
    int a = 0;
    if (htf_down || polarity < -0.04 || micro_down || bias == "DOWN") ++a;
    if (mtf_down || s.body_5m < 0 || n1 < 0) ++a;
    if (ltf_down || sell_p > buy_p || st10 <= -1 || n10 < 0) ++a;
    if (bear > bull && n200 >= 30) ++a;
    return a;
  };

  auto finish = [&](const char* d, const char* st, double ev, const std::string& w) {
    *dir = d;
    *setup = st;
    *ev_out = ev;
    *why = w;
    return true;
  };

  auto annotate = [&](const std::string& core) {
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(2);
    o << core
      << " · 200c B" << bull << "/S" << bear << "/n" << n200
      << " · Pbuy " << buy_p << " Psell " << sell_p
      << " · feeds " << s.feed_contributing << "/" << s.feed_sender_count << " " << agree
      << " · 15m " << (n15 * 10000.0) << "bp 5m " << (n5 * 10000.0) << "bp"
      << " · 10s " << (n10 * 10000.0) << "bp"
      << " · bias " << bias;
    return o.str();
  };

  // Soft block only when pressure is strongly against AND micro does not disagree.
  if (!failed_bo && !range_ctx) {
    if (want_buy && sell_p > buy_p + 0.55 && polarity < -0.15 && !micro_up && bias != "UP")
      want_buy = false;
    if (want_sell && buy_p > sell_p + 0.55 && polarity > 0.15 && !micro_down && bias != "DOWN")
      want_sell = false;
  }

  // Live side: last bar may be QUIET after the impulse — still trade the move.
  bool live_buy = want_buy && (climb || micro_up || n10 > 0.00015 || st10 >= 1 || prior_climb);
  bool live_sell = want_sell && (dump || micro_down || n10 < -0.00015 || st10 <= -1 || prior_dump);
  if (bias == "UP" && (micro_up || n10 > 0.0002 || up_ctx || climb)) live_buy = true;
  if (bias == "DOWN" && (micro_down || n10 < -0.0002 || down_ctx || dump)) live_sell = true;
  // Regime chart plan from Node (BREAKOUT_UP → BUY BREAKOUT, etc.) — this IS the entry idea.
  if (plan_dir == "BUY") {
    want_buy = true;
    if (feed_confirm != "FIGHT" || micro_up || climb || n10 > 0) live_buy = true;
  }
  if (plan_dir == "SELL") {
    want_sell = true;
    if (feed_confirm != "FIGHT" || micro_down || dump || n10 < 0) live_sell = true;
  }
  if (want_buy && want_sell) {
    if (plan_dir == "BUY") want_sell = false;
    else if (plan_dir == "SELL") want_buy = false;
  }

  auto setup_for_buy = [&]() -> const char* {
    if (!plan_setup.empty() && plan_dir == "BUY") {
      if (plan_setup == "BREAKOUT") return "BREAKOUT";
      if (plan_setup == "PULLBACK") return "PULLBACK";
      if (plan_setup == "CONTINUATION") return "CONTINUATION";
      if (plan_setup == "RANGE_REJECTION") return "RANGE_REJECTION";
      if (plan_setup == "FAILED_BREAKOUT") return "FAILED_BREAKOUT";
      if (plan_setup == "REVERSAL" || plan_setup == "FADE") return "REVERSAL";
    }
    if (regime.find("BREAKOUT_UP") != std::string::npos) return "BREAKOUT";
    if (failed_bo && regime.find("DOWN") != std::string::npos) return "FAILED_BREAKOUT";
    if (range_ctx && rpos < 0.35) return "RANGE_REJECTION";
    if (dump || (prior_dump && climb)) return dump ? "PULLBACK" : "CONTINUATION";
    if (regime.find("PULLBACK") != std::string::npos) return prior_dump ? "CONTINUATION" : "PULLBACK";
    if (regime.find("TREND") != std::string::npos || regime.find("EXPANSION") != std::string::npos)
      return prior_dump ? "CONTINUATION" : (dump ? "PULLBACK" : "CONTINUATION");
    return micro_up ? "CONTINUATION" : "PULLBACK";
  };
  auto setup_for_sell = [&]() -> const char* {
    if (!plan_setup.empty() && plan_dir == "SELL") {
      if (plan_setup == "BREAKOUT") return "BREAKOUT";
      if (plan_setup == "PULLBACK") return "PULLBACK";
      if (plan_setup == "CONTINUATION") return "CONTINUATION";
      if (plan_setup == "RANGE_REJECTION") return "RANGE_REJECTION";
      if (plan_setup == "FAILED_BREAKOUT") return "FAILED_BREAKOUT";
      if (plan_setup == "REVERSAL" || plan_setup == "FADE") return "REVERSAL";
    }
    if (regime.find("BREAKOUT_DOWN") != std::string::npos) return "BREAKOUT";
    if (failed_bo && regime.find("UP") != std::string::npos) return "FAILED_BREAKOUT";
    if (range_ctx && rpos > 0.65) return "RANGE_REJECTION";
    if (climb || (prior_climb && dump)) return climb ? "PULLBACK" : "CONTINUATION";
    if (regime.find("PULLBACK") != std::string::npos) return prior_climb ? "CONTINUATION" : "PULLBACK";
    if (regime.find("TREND") != std::string::npos || regime.find("EXPANSION") != std::string::npos)
      return prior_climb ? "CONTINUATION" : (climb ? "PULLBACK" : "CONTINUATION");
    return micro_down ? "CONTINUATION" : "PULLBACK";
  };

  // --- Regime chart plan FIRST (all confirms / plan_ready → EntryReady, never block) ---
  bool plan_ready = false;
  // plan_ready from snapshot when Node published confirm_ok==confirm_n
  // (parsed into feed_confirm/plan fields; also trust plan_dir alone when not FIGHT)
  if (plan_dir == "BUY" && (feed_confirm != "FIGHT" || micro_up || n10 > 0)) {
    want_buy = true;
    live_buy = true;
    return finish("BUY", setup_for_buy(), std::max(ev_buy, MIN_EV),
                  annotate("REGIME PLAN " + (plan_setup.empty() ? std::string("BUY") : plan_setup) +
                           " · feeds " + (feed_confirm.empty() ? "n/a" : feed_confirm)));
  }
  if (plan_dir == "SELL" && (feed_confirm != "FIGHT" || micro_down || n10 < 0)) {
    want_sell = true;
    live_sell = true;
    return finish("SELL", setup_for_sell(), std::max(ev_sell, MIN_EV),
                  annotate("REGIME PLAN " + (plan_setup.empty() ? std::string("SELL") : plan_setup) +
                           " · feeds " + (feed_confirm.empty() ? "n/a" : feed_confirm)));
  }
  // Feeds fight: still allow if micro impulse clearly holds the plan side
  if (plan_dir == "BUY" && (micro_up || n10 > 0.0003) && feed_confirm == "FIGHT") {
    return finish("BUY", setup_for_buy(), std::max(ev_buy, MIN_EV),
                  annotate("REGIME PLAN hold vs feed fight"));
  }
  if (plan_dir == "SELL" && (micro_down || n10 < -0.0003) && feed_confirm == "FIGHT") {
    return finish("SELL", setup_for_sell(), std::max(ev_sell, MIN_EV),
                  annotate("REGIME PLAN hold vs feed fight"));
  }
  (void)plan_ready;

  // --- ALL regimes fallback ---

  // FAILED BREAKOUT fade
  if (failed_bo) {
    if (regime.find("UP") != std::string::npos && live_sell && ev_sell > MIN_EV_MICRO) {
      return finish("SELL", "FAILED_BREAKOUT", ev_sell, annotate("FAILED_BREAKOUT fade short"));
    }
    if (regime.find("DOWN") != std::string::npos && live_buy && ev_buy > MIN_EV_MICRO) {
      return finish("BUY", "FAILED_BREAKOUT", ev_buy, annotate("FAILED_BREAKOUT fade long"));
    }
  }

  // BREAKOUT_UP / BREAKOUT_DOWN — highs/lows are expected, never veto on rpos
  if (regime.find("BREAKOUT_UP") != std::string::npos && live_buy &&
      (ev_buy > MIN_EV_MICRO || bias == "UP") && tf_align_buy() >= 1) {
    return finish("BUY", "BREAKOUT", std::max(ev_buy, MIN_EV), annotate("BREAKOUT_UP follow"));
  }
  if (regime.find("BREAKOUT_DOWN") != std::string::npos && live_sell &&
      (ev_sell > MIN_EV_MICRO || bias == "DOWN") && tf_align_sell() >= 1) {
    return finish("SELL", "BREAKOUT", std::max(ev_sell, MIN_EV), annotate("BREAKOUT_DOWN follow"));
  }

  // TREND_UP / TREND_DOWN / PULLBACK_* / EXPANSION
  if ((up_ctx || regime.find("EXPANSION") != std::string::npos) && live_buy &&
      ev_buy > MIN_EV_MICRO && tf_align_buy() >= 1) {
    return finish("BUY", setup_for_buy(), std::max(ev_buy, MIN_EV),
                  annotate(std::string(s.regime) + " with-trend long"));
  }
  if ((down_ctx || (regime.find("EXPANSION") != std::string::npos && bias == "DOWN")) &&
      live_sell && ev_sell > MIN_EV_MICRO && tf_align_sell() >= 1) {
    return finish("SELL", setup_for_sell(), std::max(ev_sell, MIN_EV),
                  annotate(std::string(s.regime) + " with-trend short"));
  }

  // RANGE rejection OR micro break of range
  if (range_ctx) {
    if (live_sell && (rpos > 0.7 || dump) && ev_sell > MIN_EV_MICRO && tf_align_sell() >= 1) {
      return finish("SELL", "RANGE_REJECTION", std::max(ev_sell, MIN_EV),
                    annotate("RANGE rejection short"));
    }
    if (live_buy && (rpos < 0.3 || climb) && ev_buy > MIN_EV_MICRO && tf_align_buy() >= 1) {
      return finish("BUY", "RANGE_REJECTION", std::max(ev_buy, MIN_EV),
                    annotate("RANGE rejection long"));
    }
  }

  // MICRO impulse — any regime, including UNKNOWN / TRANSITION / COMPRESSION
  if (live_buy && micro_up && ev_buy > MIN_EV_MICRO && tf_align_buy() >= 1) {
    return finish("BUY", setup_for_buy(), std::max(ev_buy, MIN_EV),
                  annotate("MICRO impulse long · " + s.regime));
  }
  if (live_sell && micro_down && ev_sell > MIN_EV_MICRO && tf_align_sell() >= 1) {
    return finish("SELL", setup_for_sell(), std::max(ev_sell, MIN_EV),
                  annotate("MICRO impulse short · " + s.regime));
  }

  // Bias-led catch-all — board says UP/DOWN, must not SCAN forever
  if (bias == "UP" && live_buy && ev_buy > MIN_EV_MICRO && (tf_align_buy() >= 1 || n10 > 0 || climb || micro_up)) {
    return finish("BUY", setup_for_buy(), std::max(ev_buy, MIN_EV),
                  annotate("BIAS UP catch-all · " + s.regime));
  }
  if (bias == "DOWN" && live_sell && ev_sell > MIN_EV_MICRO &&
      (tf_align_sell() >= 1 || n10 < 0 || dump || micro_down)) {
    return finish("SELL", setup_for_sell(), std::max(ev_sell, MIN_EV),
                  annotate("BIAS DOWN catch-all · " + s.regime));
  }

  // Last resort: clear 10s net with pressure
  if (ev_buy >= ev_sell && ev_buy > MIN_EV && want_buy && n10 > 0.00025 && buy_p >= sell_p - 0.05) {
    return finish("BUY", setup_for_buy(), ev_buy, annotate("NET 10s long · " + s.regime));
  }
  if (ev_sell > ev_buy && ev_sell > MIN_EV && want_sell && n10 < -0.00025 && sell_p >= buy_p - 0.05) {
    return finish("SELL", setup_for_sell(), ev_sell, annotate("NET 10s short · " + s.regime));
  }

  return false;
}

static int self_test() {
  Snap s;
  s.epic = "GOLD";
  s.regime = "TREND_UP";
  s.bias = "UP";
  s.feed_agreement = "STRONG";
  s.feed_contributing = 4;
  s.feed_sender_count = 5;
  s.mid = 2400;
  s.bid = 2399.5;
  s.ask = 2400.5;
  s.pressure_net = 0.4;
  s.pressure_buy = 0.4;
  s.pressure_sell = 0;
  s.body_1m = 0.2;
  s.body_5m = 0.15;
  s.body_15m = 0.1;
  s.c200_n = 200;
  s.c200_bull = 118;
  s.c200_bear = 72;
  s.c200_doji = 10;
  // 15m / 5m up structure
  for (int i = 0; i < 8; ++i) {
    double c = 2380 + i * 2.5;
    s.bars_15m.push_back({c - 1, c + 1, c - 2, c});
  }
  for (int i = 0; i < 12; ++i) {
    double c = 2390 + i * 0.8;
    s.bars_5m.push_back({c - 0.5, c + 0.5, c - 1, c});
  }
  for (int i = 0; i < 30; ++i) {
    double c = 2395 + i * 0.15;
    s.bars_1m.push_back({c - 0.1, c + 0.2, c - 0.2, c});
  }
  // 10s: dip after climb (pullback buy)
  s.bars.push_back({2400, 2401, 2399.5, 2400.8});
  s.bars.push_back({2400.8, 2401.2, 2399.2, 2399.4}); // dump
  std::string dir, setup, why;
  double ev = 0;
  if (!decide(s, &dir, &setup, &why, &ev) || dir != "BUY") {
    std::cerr << "self-test FAIL buy pullback: " << dir << " " << setup << " " << why << "\n";
    return 1;
  }
  if (setup != "PULLBACK" && setup != "CONTINUATION") {
    std::cerr << "self-test FAIL setup " << setup << "\n";
    return 1;
  }
  std::cerr << "self-test OK " << dir << " " << setup << " EV=" << ev << " · " << why << "\n";

  // Downtrend dump continuation
  Snap d = s;
  d.regime = "TREND_DOWN";
  d.bias = "DOWN";
  d.pressure_net = -0.45;
  d.pressure_buy = 0;
  d.pressure_sell = 0.45;
  d.body_1m = -0.2;
  d.body_5m = -0.15;
  d.body_15m = -0.12;
  d.c200_bull = 70;
  d.c200_bear = 120;
  d.bars_15m.clear();
  d.bars_5m.clear();
  d.bars_1m.clear();
  d.bars.clear();
  for (int i = 0; i < 8; ++i) {
    double c = 2420 - i * 2.5;
    d.bars_15m.push_back({c + 1, c + 1.5, c - 1, c});
  }
  for (int i = 0; i < 12; ++i) {
    double c = 2410 - i * 0.8;
    d.bars_5m.push_back({c + 0.5, c + 0.6, c - 0.5, c});
  }
  for (int i = 0; i < 30; ++i) {
    double c = 2405 - i * 0.15;
    d.bars_1m.push_back({c + 0.1, c + 0.15, c - 0.2, c});
  }
  d.bars.push_back({2398, 2398.5, 2396, 2396.5}); // prior climb? red
  d.bars.push_back({2396.5, 2397, 2394, 2394.5}); // dump
  // make prior climb
  d.bars[0] = {2395, 2398.5, 2394.8, 2398}; // climb
  d.bars[1] = {2398, 2398.2, 2394, 2394.2}; // dump
  if (!decide(d, &dir, &setup, &why, &ev) || dir != "SELL") {
    std::cerr << "self-test FAIL sell: " << dir << " " << setup << " " << why << "\n";
    return 1;
  }
  std::cerr << "self-test OK " << dir << " " << setup << " EV=" << ev << " · " << why << "\n";

  // Screenshot case: FLAT bias + softish 200c day, but clear 10s climb → must BUY (not SCAN).
  Snap g;
  g.epic = "GOLD";
  g.regime = "RANGE";
  g.bias = "FLAT";
  g.feed_agreement = "OK";
  g.feed_contributing = 3;
  g.feed_sender_count = 4;
  g.mid = 4519.19;
  g.bid = 4519.19;
  g.ask = 4519.49;
  g.pressure_net = 0.05;
  g.pressure_buy = 0.05;
  g.pressure_sell = 0;
  g.body_1m = 0.12;
  g.body_5m = 0.08;
  g.body_15m = -0.02;
  g.c200_n = 200;
  g.c200_bull = 90;
  g.c200_bear = 105;
  g.c200_doji = 5;
  for (int i = 0; i < 20; ++i) {
    double c = 4510 + i * 0.2;
    g.bars_1m.push_back({c - 0.1, c + 0.15, c - 0.15, c});
  }
  // 10s climb ~4515 → 4519 like the phone chart
  g.bars.push_back({4515.0, 4516.0, 4514.8, 4515.8});
  g.bars.push_back({4515.8, 4517.2, 4515.6, 4517.0});
  g.bars.push_back({4517.0, 4518.5, 4516.9, 4518.2});
  g.bars.push_back({4518.2, 4519.5, 4518.0, 4519.2});
  if (!decide(g, &dir, &setup, &why, &ev) || dir != "BUY") {
    std::cerr << "self-test FAIL gold climb FLAT: " << dir << " " << setup << " " << why << "\n";
    return 1;
  }
  std::cerr << "self-test OK gold-climb " << dir << " " << setup << " EV=" << ev << " · " << why << "\n";

  // Desk screenshot: BREAKOUT_UP + bias UP + DIVERGENT feeds + QUIET last bar at highs → must BUY
  Snap bo;
  bo.epic = "GOLD";
  bo.regime = "BREAKOUT_UP";
  bo.bias = "UP";
  bo.plan_direction = "BUY";
  bo.plan_setup = "BREAKOUT";
  bo.feed_confirm = "CONFIRM";
  bo.feed_mid = 4522.4;
  bo.feed_agreement = "DIVERGENT";
  bo.feed_contributing = 10;
  bo.feed_sender_count = 12;
  bo.mid = 4522.14;
  bo.bid = 4521.99;
  bo.ask = 4522.29;
  bo.pressure_net = 0.1;
  bo.pressure_buy = 0.1;
  bo.pressure_sell = 0;
  bo.body_1m = 0.1;
  bo.body_5m = 0.05;
  bo.body_15m = 0.02;
  bo.c200_n = 200;
  bo.c200_bull = 95;
  bo.c200_bear = 100;
  for (int i = 0; i < 25; ++i) {
    double c = 4515 + i * 0.25;
    bo.bars_1m.push_back({c - 0.1, c + 0.2, c - 0.15, c});
  }
  bo.bars.push_back({4519.0, 4520.5, 4518.8, 4520.2});
  bo.bars.push_back({4520.2, 4521.8, 4520.0, 4521.5});
  bo.bars.push_back({4521.5, 4522.5, 4521.3, 4522.3});
  // QUIET last bar at highs (desk showed QUIET) — must still EntryReady
  bo.bars.push_back({4522.21, 4522.21, 4522.11, 4522.11});
  if (!decide(bo, &dir, &setup, &why, &ev) || dir != "BUY") {
    std::cerr << "self-test FAIL BREAKOUT_UP quiet: " << dir << " " << setup << " " << why << "\n";
    return 1;
  }
  if (setup != std::string("BREAKOUT") && setup != "CONTINUATION" && setup != "PULLBACK") {
    std::cerr << "self-test FAIL BREAKOUT setup " << setup << "\n";
    return 1;
  }
  std::cerr << "self-test OK breakout-up " << dir << " " << setup << " EV=" << ev << " · " << why << "\n";

  // TREND_DOWN must SELL (fresh snap — do not inherit BREAKOUT plan from bo)
  Snap td;
  td.epic = "GOLD";
  td.regime = "TREND_DOWN";
  td.bias = "DOWN";
  td.plan_direction = "SELL";
  td.plan_setup = "CONTINUATION";
  td.feed_confirm = "CONFIRM";
  td.feed_agreement = "OK";
  td.feed_contributing = 4;
  td.feed_sender_count = 5;
  td.mid = 4519.7;
  td.bid = 4519.5;
  td.ask = 4519.9;
  td.pressure_net = -0.2;
  td.pressure_buy = 0;
  td.pressure_sell = 0.2;
  td.body_1m = -0.1;
  td.body_5m = -0.1;
  td.body_15m = -0.1;
  td.c200_n = 200;
  td.c200_bull = 80;
  td.c200_bear = 110;
  for (int i = 0; i < 25; ++i) {
    double c = 4525 - i * 0.25;
    td.bars_1m.push_back({c + 0.1, c + 0.15, c - 0.2, c});
  }
  td.bars.push_back({4522.0, 4522.2, 4520.5, 4520.8});
  td.bars.push_back({4520.8, 4521.0, 4519.5, 4519.7});
  if (!decide(td, &dir, &setup, &why, &ev) || dir != "SELL") {
    std::cerr << "self-test FAIL TREND_DOWN: " << dir << " " << setup << " " << why
              << " · plan=" << td.plan_direction << "\n";
    return 1;
  }
  std::cerr << "self-test OK trend-down " << dir << " " << setup << " EV=" << ev << " · " << why << "\n";
  return 0;
}

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--self-test") {
    return self_test();
  }
  const std::string host = env_or("VS_CALC_HOST", "127.0.0.1");
  const int port = std::atoi(env_or("CONTROL_API_PORT", "3000").c_str());
  const std::string token = env_or("PIPELINE_TOKEN", env_or("PIPELINE_SERVICE_TOKEN"));
  if (token.empty() || token.find("CHANGE_ME") != std::string::npos) {
    std::cerr << "vs-calc: set PIPELINE_TOKEN\n";
    return 1;
  }
  std::cerr << "vs-calc SUPER C++ started → " << host << ":" << port << "\n";
  std::map<std::string, std::chrono::steady_clock::time_point> last_sent;
  for (;;) {
    std::string body;
    http("GET", host, port, "/api/pipeline/calc-snapshot", token, "", &body);
    auto snaps = parse_snaps(body);
    std::vector<std::string> epics;
    for (const auto& s : snaps) epics.push_back(s.epic);
    std::ostringstream hb;
    hb << "{\"epics\":[";
    for (size_t i = 0; i < epics.size(); ++i) {
      if (i) hb << ',';
      hb << '"' << epics[i] << '"';
    }
    hb << "]}";
    std::string hbr;
    http("POST", host, port, "/api/pipeline/heartbeat", token, hb.str(), &hbr);

    for (const auto& s : snaps) {
      if (s.bars.empty() && s.bars_1m.empty() && s.mid <= 0) continue;
      auto now = std::chrono::steady_clock::now();
      if (last_sent.count(s.epic) && now - last_sent[s.epic] < std::chrono::seconds(12)) continue;
      std::string dir, setup, why;
      double ev = 0;
      if (!decide(s, &dir, &setup, &why, &ev)) continue;
      for (char& ch : why) if (ch == '"' || ch == '\\') ch = ' ';
      for (char& ch : setup) if (ch == '"' || ch == '\\') ch = ' ';
      long bucket = (long)(std::time(nullptr) / 10);
      double ref = s.mid > 0 ? s.mid : (s.bars.empty() ? s.bars_1m.back().c : s.bars.back().c);
      std::ostringstream intent;
      intent << "{\"epic\":\"" << s.epic << "\",\"direction\":\"" << dir
             << "\",\"decision\":\"ENTRY_READY\",\"setup_type\":\"" << setup << "\","
             << "\"regime\":\"" << s.regime << "\","
             << "\"explanation\":\"" << why << "\","
             << "\"reference_price\":" << ref << ","
             << "\"idempotency_key\":\"cpp-" << s.epic << "-" << bucket << "-" << dir << "\"}";
      std::string ir;
      if (http("POST", host, port, "/api/pipeline/intents", token, intent.str(), &ir)) {
        last_sent[s.epic] = now;
        std::cerr << "EntryReady " << s.epic << " " << dir << " " << setup << " " << why << "\n";
      }
    }
    std::this_thread::sleep_for(std::chrono::seconds(2));
  }
}
