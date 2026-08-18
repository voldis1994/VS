/* VS calc — C++ EntryReady only. Never opens Capital (robotDesk hands do that). */
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
  double bid{}, ask{}, mid{};
  std::vector<Bar> bars;
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

static std::vector<Snap> parse_snaps(const std::string& json) {
  std::vector<Snap> out;
  size_t i = 0;
  while ((i = json.find("\"epic\"", i)) != std::string::npos) {
    auto end = json.find("\"epic\"", i + 5);
    std::string chunk = json.substr(i, end == std::string::npos ? json.size() - i : end - i);
    Snap s;
    s.epic = json_str(chunk, "epic");
    s.regime = json_str(chunk, "regime");
    s.bid = json_num(chunk, "bid");
    s.ask = json_num(chunk, "ask");
    s.mid = json_num(chunk, "mid");
    size_t b = 0;
    while ((b = chunk.find("\"c\":", b)) != std::string::npos && s.bars.size() < 40) {
      Bar bar;
      bar.c = json_num(chunk.substr(b > 40 ? b - 40 : 0), "c");
      bar.o = json_num(chunk.substr(b > 80 ? b - 80 : 0), "o");
      bar.h = json_num(chunk.substr(b > 80 ? b - 80 : 0), "h");
      bar.l = json_num(chunk.substr(b > 80 ? b - 80 : 0), "l");
      if (bar.c > 0) s.bars.push_back(bar);
      b += 4;
    }
    if (!s.epic.empty()) out.push_back(s);
    i += 6;
  }
  return out;
}

/** With-trend 10s + vein/flow. TREND_DOWN must emit SELL without waiting for vein±2. */
static bool decide(const Snap& s, std::string* dir, std::string* why, double* ev_out) {
  if (s.bars.empty()) return false;
  const Bar& last = s.bars.back();
  std::string regime = s.regime;
  for (char& ch : regime) ch = (char)std::toupper((unsigned char)ch);
  bool down_ctx =
    regime.find("TREND_DOWN") != std::string::npos ||
    regime.find("BREAKOUT_DOWN") != std::string::npos ||
    regime.find("PULLBACK_DOWN") != std::string::npos;
  bool up_ctx =
    regime.find("TREND_UP") != std::string::npos ||
    regime.find("BREAKOUT_UP") != std::string::npos ||
    regime.find("PULLBACK_UP") != std::string::npos;
  double prev_c = s.bars.size() >= 2 ? s.bars[s.bars.size() - 2].c : last.o;
  if (down_ctx && (last.c < last.o || last.c < prev_c)) {
    *dir = "SELL";
    *ev_out = 0.2;
    *why = "regime " + s.regime + " follow dump";
    return true;
  }
  if (up_ctx && (last.c > last.o || last.c > prev_c)) {
    *dir = "BUY";
    *ev_out = 0.2;
    *why = "regime " + s.regime + " follow climb";
    return true;
  }
  if (s.bars.size() < 4) return false;
  double up = 0, down = 0, hi = s.bars[0].h, lo = s.bars[0].l;
  int vein = 0;
  for (size_t i = 1; i < s.bars.size(); ++i) {
    const auto& a = s.bars[i - 1];
    const auto& b = s.bars[i];
    if (b.c > a.c) { up += 1; vein = vein >= 0 ? vein + 1 : 1; }
    else if (b.c < a.c) { down += 1; vein = vein <= 0 ? vein - 1 : -1; }
    hi = std::max(hi, b.h);
    lo = std::min(lo, b.l);
  }
  double n = double(s.bars.size() - 1);
  double net_flow = (up - down) / n;
  double lastc = last.c;
  double range_pos = (hi > lo) ? (lastc - lo) / (hi - lo) : 0.5;
  double spread = (s.ask > 0 && s.bid > 0) ? (s.ask - s.bid) / std::max(lastc, 1.0) : 0.0002;
  auto score = [&](int sign) {
    double p = 0.5 + 0.2 * (sign * net_flow) + 0.1 * (sign * vein > 0 ? 1.0 : 0.0);
    if (sign > 0 && range_pos < 0.55) p += 0.08;
    if (sign < 0 && range_pos > 0.45) p += 0.08;
    if (sign > 0 && range_pos > 0.88) p -= 0.25;
    if (sign < 0 && range_pos < 0.12) p -= 0.25;
    p = std::clamp(p, 0.05, 0.95);
    return p * 1.0 - (1.0 - p) * 1.0 - spread * 8.0;
  };
  double ev_buy = score(1);
  double ev_sell = score(-1);
  if (ev_buy >= ev_sell && ev_buy > 0.02 && net_flow > 0 && vein >= 1) {
    *dir = "BUY";
    *ev_out = ev_buy;
    *why = "vein long · flow+ · EV " + std::to_string(ev_buy);
    return true;
  }
  if (ev_sell > 0.02 && net_flow < 0 && vein <= -1) {
    *dir = "SELL";
    *ev_out = ev_sell;
    *why = "vein short · flow- · EV " + std::to_string(ev_sell);
    return true;
  }
  return false;
}

int main() {
  const std::string host = env_or("VS_CALC_HOST", "127.0.0.1");
  const int port = std::atoi(env_or("CONTROL_API_PORT", "3000").c_str());
  const std::string token = env_or("PIPELINE_TOKEN", env_or("PIPELINE_SERVICE_TOKEN"));
  if (token.empty() || token.find("CHANGE_ME") != std::string::npos) {
    std::cerr << "vs-calc: set PIPELINE_TOKEN\n";
    return 1;
  }
  std::cerr << "vs-calc C++ started → " << host << ":" << port << "\n";
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
      if (s.bars.empty() && s.mid <= 0) continue;
      auto now = std::chrono::steady_clock::now();
      if (last_sent.count(s.epic) && now - last_sent[s.epic] < std::chrono::seconds(12)) continue;
      std::string dir, why;
      double ev = 0;
      if (!decide(s, &dir, &why, &ev)) continue;
      for (char& ch : why) if (ch == '"' || ch == '\\') ch = ' ';
      long bucket = (long)(std::time(nullptr) / 10);
      std::ostringstream intent;
      intent << "{\"epic\":\"" << s.epic << "\",\"direction\":\"" << dir
             << "\",\"decision\":\"ENTRY_READY\",\"setup_type\":\"vein_flow\","
             << "\"regime\":\"" << s.regime << "\","
             << "\"explanation\":\"" << why << "\","
             << "\"reference_price\":" << (s.mid > 0 ? s.mid : s.bars.back().c) << ","
             << "\"idempotency_key\":\"cpp-" << s.epic << "-" << bucket << "-" << dir << "\"}";
      std::string ir;
      if (http("POST", host, port, "/api/pipeline/intents", token, intent.str(), &ir)) {
        last_sent[s.epic] = now;
        std::cerr << "EntryReady " << s.epic << " " << dir << " " << why << "\n";
      }
    }
    std::this_thread::sleep_for(std::chrono::seconds(2));
  }
}
