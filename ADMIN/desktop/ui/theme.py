"""VS dark desktop QSS — shared visual language with CLIENT web and Server Monitor."""

from app.version import ADMIN_VERSION

APP_QSS = """
QMainWindow, QWidget {
  background: #050607;
  color: #eef3f0;
  font-family: "Segoe UI", "IBM Plex Sans", "Noto Sans", sans-serif;
  font-size: 13px;
}
QListWidget#nav {
  background: #080b0e;
  border: none;
  border-right: 1px solid #1c242c;
  color: #7d8882;
  padding: 12px 8px;
  outline: none;
}
QListWidget#nav::item {
  padding: 10px 12px;
  margin: 2px 0;
  border-radius: 4px;
}
QListWidget#nav::item:selected {
  background: #121a16;
  color: #2ef28a;
}
QListWidget#nav::item:hover {
  background: #10161a;
  color: #eef3f0;
}
QFrame#header {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #0b0f12, stop:1 #090c0f);
  border-bottom: 1px solid #1c242c;
  min-height: 56px;
}
QLabel#brand {
  color: #2ef28a;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 3px;
}
QLabel#chip {
  padding: 5px 10px;
  border: 1px solid #1c242c;
  color: #c5ccc8;
  font-size: 11px;
  letter-spacing: 0.5px;
}
QLabel#muted { color: #7d8882; }
QFrame#Card {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #141b21, stop:1 #10151a);
  border: 1px solid #1c242c;
}
QLabel#CardLabel { color: #7d8882; font-size: 11px; letter-spacing: 1px; }
QLabel#CardValue { font-size: 26px; font-weight: 700; }
QLabel#CardValue[ok="true"] { color: #2ef28a; }
QLabel#Section {
  color: #2ef28a;
  font-size: 12px;
  letter-spacing: 2px;
  font-weight: 700;
}
QTableView, QTableWidget {
  background: #0c1014;
  gridline-color: #1c242c;
  border: 1px solid #1c242c;
  selection-background-color: #121a16;
  alternate-background-color: #0e1318;
}
QHeaderView::section {
  background: #080b0e;
  color: #7d8882;
  border: none;
  padding: 8px;
}
QLineEdit, QPlainTextEdit, QTextEdit {
  background: #0b1014;
  border: 1px solid #1c242c;
  padding: 8px;
  color: #eef3f0;
}
QPushButton#Primary {
  background: #102018;
  border: 1px solid #178a4c;
  color: #2ef28a;
  padding: 8px 14px;
}
QStatusBar { background: #080b0e; color: #7d8882; }
QScrollBar:vertical { background: #080b0e; width: 10px; }
QScrollBar::handle:vertical { background: #1c242c; min-height: 24px; }
"""

VS_QSS = APP_QSS
