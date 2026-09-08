//+------------------------------------------------------------------+
//| VS_MASTER.mq4 — VS MASTER MT4 file bridge (from Check- CHECK v5) |
//| Attach to M1. BridgePath empty = MQL4/Files/VS_MASTER            |
//| ACK includes fill + profit on OPEN/CLOSE for honest journal PnL  |
//+------------------------------------------------------------------+
#property copyright "VS MASTER"
#property version   "6.00"
#property strict

extern string BridgePath = "";
extern int    MagicNumber = 60001;
extern int    MaxBarsM1   = 300;
extern int    ExportSec   = 1;

string g_root;
datetime g_last_export = 0;

string JoinPath(string a, string b)
{
   if(StringLen(a) == 0) return(b);
   int n = StringLen(a);
   if(StringGetCharacter(a, n - 1) == '\\' || StringGetCharacter(a, n - 1) == '/')
      return(a + b);
   return(a + "\\" + b);
}

void EnsureDir(string path)
{
   CreateDirectory(path);
}

string BridgeRoot()
{
   if(StringLen(BridgePath) > 0) return(BridgePath);
   return("VS_MASTER");
}

void BootDirs()
{
   g_root = BridgeRoot();
   EnsureDir(g_root);
   EnsureDir(JoinPath(g_root, "market"));
   EnsureDir(JoinPath(g_root, "status"));
   EnsureDir(JoinPath(g_root, "commands"));
   EnsureDir(JoinPath(g_root, "acks"));
}

string JNum(double v, int dig) { return(DoubleToStr(v, dig)); }

string JStr(string s)
{
   string o = s;
   StringReplace(o, "\\", "\\\\");
   StringReplace(o, "\"", "\\\"");
   return("\"" + o + "\"");
}

string IsoNow() { return(TimeToStr(TimeCurrent(), TIME_DATE|TIME_SECONDS)); }

int FileWriteText(string rel, string body)
{
   int h = FileOpen(rel, FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h < 0) return(-1);
   FileWriteString(h, body);
   FileClose(h);
   return(0);
}

string FileReadText(string rel)
{
   int h = FileOpen(rel, FILE_READ|FILE_TXT|FILE_ANSI);
   if(h < 0) return("");
   string out = "";
   while(!FileIsEnding(h))
      out = out + FileReadString(h) + "\n";
   FileClose(h);
   return(out);
}

string JsonGetStr(string json, string key)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return("");
   p = StringFind(json, ":", p);
   if(p < 0) return("");
   int q1 = StringFind(json, "\"", p + 1);
   if(q1 < 0) return("");
   int q2 = StringFind(json, "\"", q1 + 1);
   if(q2 < 0) return("");
   return(StringSubstr(json, q1 + 1, q2 - q1 - 1));
}

double JsonGetNum(string json, string key)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return(0);
   p = StringFind(json, ":", p);
   if(p < 0) return(0);
   int i = p + 1;
   while(i < StringLen(json))
   {
      int ch = StringGetCharacter(json, i);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') { i++; continue; }
      break;
   }
   string num = "";
   while(i < StringLen(json))
   {
      int ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == '+')
      {
         num = num + CharToStr(ch);
         i++;
         continue;
      }
      break;
   }
   return(StrToDouble(num));
}

string BuildBarsM1()
{
   int n = MathMin(MaxBarsM1, Bars);
   if(n < 2) n = Bars;
   string body = "[";
   bool first = true;
   for(int i = n - 1; i >= 0; i--)
   {
      if(!first) body = body + ",";
      first = false;
      body = body + "{"
         + "\"t\":" + IntegerToString((int)Time[i]) + ","
         + "\"o\":" + JNum(Open[i], Digits) + ","
         + "\"h\":" + JNum(High[i], Digits) + ","
         + "\"l\":" + JNum(Low[i], Digits) + ","
         + "\"c\":" + JNum(Close[i], Digits) + ","
         + "\"v\":" + JNum(Volume[i], 0)
         + "}";
   }
   return(body + "]");
}

void ExportMarket()
{
   string path = JoinPath(JoinPath(g_root, "market"), "latest.json");
   string body = "{"
      + "\"ts\":" + JStr(IsoNow()) + ","
      + "\"account\":" + JStr(IntegerToString(AccountNumber())) + ","
      + "\"server\":" + JStr(AccountServer()) + ","
      + "\"symbol\":" + JStr(Symbol()) + ","
      + "\"bid\":" + JNum(Bid, Digits) + ","
      + "\"ask\":" + JNum(Ask, Digits) + ","
      + "\"digits\":" + IntegerToString(Digits) + ","
      + "\"point\":" + JNum(Point, Digits) + ","
      + "\"spread\":" + IntegerToString(MarketInfo(Symbol(), MODE_SPREAD)) + ","
      + "\"bars_m1\":" + BuildBarsM1()
      + "}";
   FileWriteText(path, body);
}

void ExportStatus()
{
   string pos = "[";
   bool first = true;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderMagicNumber() != MagicNumber) continue;
      if(OrderSymbol() != Symbol()) continue;
      if(OrderType() > OP_SELL) continue;
      if(!first) pos = pos + ",";
      first = false;
      string side = (OrderType() == OP_BUY ? "BUY" : "SELL");
      pos = pos + "{"
         + "\"ticket\":" + IntegerToString(OrderTicket()) + ","
         + "\"symbol\":" + JStr(OrderSymbol()) + ","
         + "\"side\":" + JStr(side) + ","
         + "\"lot\":" + JNum(OrderLots(), 2) + ","
         + "\"open\":" + JNum(OrderOpenPrice(), Digits) + ","
         + "\"sl\":" + JNum(OrderStopLoss(), Digits) + ","
         + "\"tp\":" + JNum(OrderTakeProfit(), Digits) + ","
         + "\"profit\":" + JNum(OrderProfit() + OrderSwap() + OrderCommission(), 2) + ","
         + "\"price\":" + JNum((OrderType()==OP_BUY?Bid:Ask), Digits)
         + "}";
   }
   pos = pos + "]";
   string path = JoinPath(JoinPath(g_root, "status"), "latest.json");
   string body = "{"
      + "\"ts\":" + JStr(IsoNow()) + ","
      + "\"account\":" + JStr(IntegerToString(AccountNumber())) + ","
      + "\"balance\":" + JNum(AccountBalance(), 2) + ","
      + "\"equity\":" + JNum(AccountEquity(), 2) + ","
      + "\"margin\":" + JNum(AccountMargin(), 2) + ","
      + "\"connected\":true,"
      + "\"trading_allowed\":" + (IsTradeAllowed() ? "true" : "false") + ","
      + "\"positions\":" + pos
      + "}";
   FileWriteText(path, body);
}

void Ack(string id, bool ok, int ticket, string err, double fill, double profit)
{
   string path = JoinPath(JoinPath(g_root, "acks"), "ack_" + id + ".json");
   string body = "{"
      + "\"id\":" + JStr(id) + ","
      + "\"ok\":" + (ok ? "true" : "false") + ","
      + "\"ticket\":" + IntegerToString(ticket) + ","
      + "\"error\":" + JStr(err) + ","
      + "\"fill\":" + JNum(fill, Digits) + ","
      + "\"profit\":" + JNum(profit, 2)
      + "}";
   FileWriteText(path, body);
}

void AckSimple(string id, bool ok, int ticket, string err)
{
   Ack(id, ok, ticket, err, 0, 0);
}

bool DoOpen(string json, string id)
{
   string side = JsonGetStr(json, "side");
   double lot = JsonGetNum(json, "lot");
   double sl  = JsonGetNum(json, "sl");
   double tp  = JsonGetNum(json, "tp");
   string sym = JsonGetStr(json, "symbol");
   int magic = (int)JsonGetNum(json, "magic");
   if(magic <= 0) magic = MagicNumber;
   if(StringLen(sym) == 0) sym = Symbol();
   if(lot <= 0) lot = 0.01;
   int cmd = (side == "SELL" ? OP_SELL : OP_BUY);
   double price = (cmd == OP_BUY ? Ask : Bid);
   int ticket = OrderSend(sym, cmd, lot, price, 30, sl, tp, "VS_MASTER", magic, 0, (cmd==OP_BUY?clrDodgerBlue:clrTomato));
   if(ticket < 0)
   {
      AckSimple(id, false, 0, "OrderSend " + IntegerToString(GetLastError()));
      return(false);
   }
   Ack(id, true, ticket, "", price, 0);
   return(true);
}

bool DoModify(string json, string id)
{
   int ticket = (int)JsonGetNum(json, "ticket");
   double sl  = JsonGetNum(json, "sl");
   double tp  = JsonGetNum(json, "tp");
   if(!OrderSelect(ticket, SELECT_BY_TICKET))
   {
      AckSimple(id, false, ticket, "select");
      return(false);
   }
   if(!OrderModify(ticket, OrderOpenPrice(), sl, tp, 0, clrGold))
   {
      AckSimple(id, false, ticket, "modify " + IntegerToString(GetLastError()));
      return(false);
   }
   AckSimple(id, true, ticket, "");
   return(true);
}

bool DoClose(string json, string id)
{
   int ticket = (int)JsonGetNum(json, "ticket");
   if(!OrderSelect(ticket, SELECT_BY_TICKET))
   {
      AckSimple(id, false, ticket, "select");
      return(false);
   }
   double price = (OrderType() == OP_BUY ? Bid : Ask);
   // Capture PnL before close — OrderProfit invalid after OrderClose
   double profit = OrderProfit() + OrderSwap() + OrderCommission();
   if(!OrderClose(ticket, OrderLots(), price, 30, clrAqua))
   {
      AckSimple(id, false, ticket, "close " + IntegerToString(GetLastError()));
      return(false);
   }
   Ack(id, true, ticket, "", price, profit);
   return(true);
}

void ProcessCommands()
{
   string dir = JoinPath(g_root, "commands");
   string pattern = JoinPath(dir, "cmd_*.json");
   string name;
   int h = FileFindFirst(pattern, name);
   if(h < 0) return;
   do
   {
      string rel = JoinPath(dir, name);
      string json = FileReadText(rel);
      string id = JsonGetStr(json, "id");
      if(StringLen(id) == 0) id = name;
      string action = JsonGetStr(json, "action");
      if(action == "OPEN") DoOpen(json, id);
      else if(action == "MODIFY") DoModify(json, id);
      else if(action == "CLOSE") DoClose(json, id);
      else AckSimple(id, false, 0, "unknown action");
      FileDelete(rel);
   }
   while(FileFindNext(h, name));
   FileFindClose(h);
}

int OnInit()
{
   if(Period() != PERIOD_M1)
      Alert("VS_MASTER: attach to M1 chart");
   BootDirs();
   EventSetTimer(MathMax(1, ExportSec));
   Comment("VS MASTER bridge v6 | ", g_root);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTick()
{
   ProcessCommands();
   if(TimeCurrent() - g_last_export >= ExportSec)
   {
      ExportMarket();
      ExportStatus();
      g_last_export = TimeCurrent();
   }
}

void OnTimer() { OnTick(); }
