"""VS Server Monitor — native operations dashboard chrome."""

QSS = """
QMainWindow, QWidget {
  background: #050607;
  color: #eef3f0;
  font-family: "IBM Plex Sans", "Noto Sans", "Segoe UI", sans-serif;
  font-size: 13px;
}
QLabel#brand { color: #2ef28a; font-size: 26px; font-weight: 800; letter-spacing: 6px; }
QLabel#sub { color: #7d8882; letter-spacing: 4px; font-size: 12px; }
QLabel#live { font-size: 18px; font-weight: 800; letter-spacing: 3px; color: #2ef28a; }
QLabel#live[off="true"] { color: #ff5a5a; }
QLabel#live[off="warn"] { color: #e6b84d; }
QLabel#chip {
  padding: 6px 10px;
  border: 1px solid #1c242c;
  background: #0b1014;
  color: #c5ccc8;
  letter-spacing: 0.6px;
}
QFrame#Card, QFrame#KpiCard {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #141b21, stop:1 #0e1318);
  border: 1px solid #1c242c;
  border-radius: 8px;
}
QLabel#CardLabel { color: #7d8882; font-size: 11px; letter-spacing: 1.6px; }
QLabel#CardValue { font-size: 22px; font-weight: 700; }
QLabel#CardValue[tone="ok"] { color: #2ef28a; }
QLabel#CardValue[tone="warn"] { color: #e6b84d; }
QLabel#CardValue[tone="bad"] { color: #ff5a5a; }
QLabel#Section { color: #2ef28a; font-size: 11px; letter-spacing: 2px; font-weight: 700; }
QLabel#muted { color: #7d8882; }
QLabel[tone="ok"] { color: #2ef28a; }
QLabel[tone="warn"] { color: #e6b84d; }
QLabel[tone="bad"] { color: #ff5a5a; }
QFrame#header {
  background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #080b0e, stop:1 #0c1612);
  border-bottom: 1px solid #1c242c;
  min-height: 78px;
}
QStatusBar { background: #080b0e; color: #7d8882; border-top: 1px solid #1c242c; }
QTableView {
  background: #0c1014;
  border: 1px solid #1c242c;
  gridline-color: #1c242c;
  selection-background-color: #121a16;
  alternate-background-color: #0e1318;
}
QHeaderView::section {
  background: #080b0e;
  color: #7d8882;
  border: none;
  padding: 8px;
}
"""
