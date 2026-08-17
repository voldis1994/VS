"""VS dark desktop QSS — same product family as Server Monitor and CLIENT web."""

APP_QSS = """
QMainWindow, QWidget {
  background: #050607;
  color: #eef3f0;
  font-family: "Segoe UI", "IBM Plex Sans", "Noto Sans", sans-serif;
  font-size: 13px;
}
QWidget#sidebar {
  background: #07090c;
  border-right: 1px solid #1c242c;
}
QLabel#sideBrand {
  color: #2ef28a;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 6px;
}
QLabel#sideSub {
  color: #7d8882;
  font-size: 10px;
  letter-spacing: 3px;
}
QListWidget#nav {
  background: #07090c;
  border: none;
  color: #7d8882;
  padding: 8px 10px;
  outline: none;
}
QListWidget#nav::item {
  padding: 9px 12px;
  margin: 2px 0;
  border-radius: 6px;
}
QListWidget#nav::item:selected {
  background: #102018;
  color: #2ef28a;
  border-left: 3px solid #2ef28a;
}
QListWidget#nav::item:hover {
  background: #10161a;
  color: #eef3f0;
}
QFrame#header {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #0c1116, stop:1 #080b0e);
  border-bottom: 1px solid #1c242c;
  min-height: 58px;
}
QLabel#brand {
  color: #2ef28a;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 3px;
}
QLabel#chip {
  padding: 5px 10px;
  border: 1px solid #1c242c;
  background: #0b1014;
  color: #c5ccc8;
  font-size: 11px;
  letter-spacing: 0.6px;
  border-radius: 4px;
}
QLabel#chip[tone="ok"] { color: #2ef28a; border-color: #178a4c; }
QLabel#chip[tone="warn"] { color: #e6b84d; border-color: #7a5a18; }
QLabel#chip[tone="bad"] { color: #ff5a5a; border-color: #7a2a2a; }
QLabel#muted { color: #7d8882; }
QLabel[tone="ok"] { color: #2ef28a; }
QLabel[tone="warn"] { color: #e6b84d; }
QLabel[tone="bad"] { color: #ff5a5a; }
QFrame#Card, QFrame#KpiCard {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #141b21, stop:1 #0e1318);
  border: 1px solid #1c242c;
  border-radius: 8px;
}
QFrame#KpiCard { min-height: 92px; }
QLabel#CardLabel { color: #7d8882; font-size: 11px; letter-spacing: 1.4px; }
QLabel#CardValue { font-size: 24px; font-weight: 700; }
QLabel#CardValue[tone="ok"] { color: #2ef28a; }
QLabel#CardValue[tone="warn"] { color: #e6b84d; }
QLabel#CardValue[tone="bad"] { color: #ff5a5a; }
QLabel#Section {
  color: #2ef28a;
  font-size: 11px;
  letter-spacing: 2px;
  font-weight: 700;
}
QLabel#pill {
  background: #0b1014;
  border: 1px solid #1c242c;
  padding: 6px 4px;
  border-radius: 4px;
  font-size: 11px;
  letter-spacing: 0.8px;
}
QLabel#pill[tone="ok"] { color: #2ef28a; border-color: #178a4c; }
QLabel#pill[tone="warn"] { color: #e6b84d; }
QLabel#pill[tone="bad"] { color: #ff5a5a; border-color: #7a2a2a; }
QTableView, QTableWidget {
  background: #0c1014;
  gridline-color: #1c242c;
  border: 1px solid #1c242c;
  selection-background-color: #121a16;
  alternate-background-color: #0e1318;
  border-radius: 6px;
}
QHeaderView::section {
  background: #080b0e;
  color: #7d8882;
  border: none;
  border-bottom: 1px solid #1c242c;
  padding: 8px;
  letter-spacing: 1px;
}
QLineEdit, QPlainTextEdit, QTextEdit {
  background: #0b1014;
  border: 1px solid #1c242c;
  padding: 8px;
  color: #eef3f0;
  border-radius: 6px;
}
QPushButton#Primary {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #1d3b2a, stop:1 #102018);
  border: 1px solid #178a4c;
  color: #2ef28a;
  padding: 8px 14px;
  border-radius: 6px;
  font-weight: 700;
  letter-spacing: 1px;
}
QPushButton#Primary:hover { border-color: #2ef28a; }
QStatusBar { background: #080b0e; color: #7d8882; border-top: 1px solid #1c242c; }
QScrollBar:vertical { background: #080b0e; width: 10px; }
QScrollBar::handle:vertical { background: #1c242c; min-height: 24px; border-radius: 4px; }
QScrollArea { border: none; background: #050607; }
QLabel#workspaceTitle {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 2px;
}
"""

VS_QSS = APP_QSS
